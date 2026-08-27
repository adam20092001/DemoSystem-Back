import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CustomerDocumentType,
  ElectronicDocumentStatus,
  FiscalDocumentType,
  Prisma,
  SaleStatus,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import {
  BOLETA_GENERIC_CUSTOMER_MAX_TOTAL,
  RUC_PATTERN,
} from './constants/electronic-invoicing.constants';
import { FiscalSeriesService } from './fiscal-series.service';
import {
  ELECTRONIC_DOCUMENT_SAFE_SELECT,
  ElectronicDocumentSafeRow,
  toElectronicDocumentSnapshot,
} from './mappers/electronic-document.mapper';
import { RetryableProviderSubmissionError } from './providers/electronic-invoicing-provider-errors';
import type {
  ElectronicDocumentSubmissionPayload,
  ElectronicInvoicingProvider,
  ProviderSubmissionResult,
} from './providers/electronic-invoicing-provider.interface';
import { ELECTRONIC_INVOICING_PROVIDER } from './providers/electronic-invoicing-provider.token';
import { ElectronicDocumentSnapshot } from './types/electronic-document-snapshot';
import { IssueElectronicDocumentCommand } from './types/issue-electronic-document.command';
import { SaleFiscalSnapshot } from './types/sale-fiscal-snapshot';

/**
 * Motor de emisión fiscal interna (Fase 11, Bloque C). Sin controller, sin
 * DTO/Swagger, sin ruta HTTP en este bloque: `issue()`/`retrySubmission()`
 * son de uso exclusivamente interno (futuros controllers de la Fase 11D).
 *
 * Orquesta el flujo completo descrito en el kickoff (§18/§24-§30):
 *   1. Transacción CORTA de creación (Sale/items -> ElectronicDocument
 *      CREATED + snapshot de ítems + auditoría), sin llamar al proveedor.
 *   2. Transacción CORTA de tránsito a SUBMITTED (submissionCount++,
 *      lastSubmittedAt).
 *   3. Llamada al proveedor FUERA de cualquier transacción.
 *   4. Transacción CORTA que persiste el resultado (ACCEPTED/REJECTED) o el
 *      fallo técnico (SUBMISSION_FAILED), con su auditoría atómica.
 *
 * `retrySubmission()` reutiliza los pasos 2-4 sobre un documento YA
 * existente en SUBMISSION_FAILED: nunca crea otro ElectronicDocument ni
 * asigna otro número fiscal.
 */
@Injectable()
export class ElectronicDocumentsService {
  private readonly logger = new Logger(ElectronicDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly fiscalSeriesService: FiscalSeriesService,
    @Inject(ELECTRONIC_INVOICING_PROVIDER)
    private readonly provider: ElectronicInvoicingProvider,
  ) {}

  /**
   * Emite un documento fiscal nuevo para una venta y lo envía al proveedor.
   * La serie es SIEMPRE explícita (§5): nunca se elige automáticamente la
   * primera FiscalSeries activa del tipo de documento solicitado.
   */
  async issue(
    command: IssueElectronicDocumentCommand,
  ): Promise<ElectronicDocumentSnapshot> {
    const documentId = await this.createDocumentTransaction(command);
    return this.runSubmissionFlow(
      documentId,
      [ElectronicDocumentStatus.CREATED],
      command.actorUserId,
      command.ipAddress ?? null,
    );
  }

  /**
   * Reintenta el envío de un documento existente en SUBMISSION_FAILED
   * (§30). Nunca crea otro ElectronicDocument ni asigna otro número fiscal:
   * reutiliza la MISMA fila, serie, número e ítems.
   */
  async retrySubmission(
    documentId: string,
    actorUserId: string | null,
    ipAddress?: string | null,
  ): Promise<ElectronicDocumentSnapshot> {
    return this.runSubmissionFlow(
      documentId,
      [ElectronicDocumentStatus.SUBMISSION_FAILED],
      actorUserId,
      ipAddress ?? null,
    );
  }

  // ==================================================================
  // Fase 1 — transacción de creación (§6-§18)
  // ==================================================================

  private async createDocumentTransaction(
    command: IssueElectronicDocumentCommand,
  ): Promise<string> {
    try {
      return await this.prisma.$transaction((tx) =>
        this.createFiscalDocument(tx, command),
      );
    } catch (error) {
      // §19: la protección final de concurrencia es el índice único parcial
      // electronic_documents_one_primary_per_sale (más el único compuesto
      // documentType+series+number). Si esta transacción pierde la carrera
      // frente a otra, Postgres revierte la transacción COMPLETA —
      // incluida la asignación de FiscalSeries ya hecha en el mismo tx—, y
      // aquí se traduce el P2002 crudo en un ConflictException limpio,
      // nunca un error de Prisma/Postgres expuesto tal cual.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'La venta ya tiene un documento fiscal primario, o el número fiscal ya fue asignado por otra operación concurrente',
        );
      }
      throw error;
    }
  }

  private async createFiscalDocument(
    tx: Prisma.TransactionClient,
    command: IssueElectronicDocumentCommand,
  ): Promise<string> {
    const sale = await this.loadSaleSnapshot(tx, command.saleId);

    // §6: ni PAID, ni saldo cero. Solo ACTIVE/CANCELLED importan aquí.
    if (sale.status === SaleStatus.CANCELLED) {
      throw new ConflictException(
        'La venta está anulada; no admite un nuevo documento fiscal primario',
      );
    }

    // §7: pre-chequeo de aplicación — insuficiente por sí solo frente a una
    // carrera real (ver §19), pero evita gastar un número fiscal en el
    // camino feliz sin concurrencia.
    const existingPrimary = await tx.electronicDocument.findFirst({
      where: {
        saleId: sale.id,
        documentType: {
          in: [FiscalDocumentType.FACTURA, FiscalDocumentType.BOLETA],
        },
      },
      select: { id: true },
    });
    if (existingPrimary !== null) {
      throw new ConflictException(
        'La venta ya tiene un documento fiscal primario (FACTURA o BOLETA)',
      );
    }

    const issuer = await this.loadAndValidateIssuer(tx);

    this.validateCustomerForDocumentType(command.documentType, sale);

    // §15/§16: la serie es explícita; el propio allocateNext() falla antes
    // de asignar nada si documentType/series no coinciden con ninguna fila,
    // si la serie está inactiva, o si está agotada.
    const allocation = await this.fiscalSeriesService.allocateNext(
      tx,
      command.documentType,
      command.series,
    );

    // §11: nunca se recalcula desde CompanySettings — taxableBase se
    // deriva aritméticamente de subtotal/discountAmount YA congelados en
    // Sale (misma invariante que sales_total_arithmetic garantiza en la
    // propia Sale), y taxAmount/total se copian tal cual.
    const taxableBase = sale.subtotal.minus(sale.discountAmount);
    const issuedAt = new Date();

    const created = await tx.electronicDocument.create({
      data: {
        saleId: sale.id,
        fiscalSeriesId: allocation.fiscalSeriesId,
        documentType: command.documentType,
        series: command.series,
        number: allocation.number,
        status: ElectronicDocumentStatus.CREATED,
        providerCode: this.provider.code,
        currencyCode: sale.currencyCode,
        issuerTaxId: issuer.taxId,
        issuerBusinessName: issuer.businessName,
        issuerAddress: issuer.address,
        customerDocumentType: sale.customerDocumentType,
        customerDocumentNumber: sale.customerDocumentNumber,
        customerName: sale.customerName,
        customerAddress: sale.customerAddress,
        subtotal: sale.subtotal,
        discountAmount: sale.discountAmount,
        taxableBase,
        taxAmount: sale.taxAmount,
        total: sale.total,
        issuedAt,
        items: {
          create: sale.items.map((item, index) => ({
            lineNumber: index + 1,
            productSku: item.productSku,
            description: item.productName,
            unitCode: item.unitCode,
            unitName: item.unitName,
            unitAbbreviation: item.unitAbbreviation,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            lineTotal: item.lineTotal,
          })),
        },
      },
      select: { id: true },
    });

    await this.auditService.record({
      userId: command.actorUserId,
      module: 'ELECTRONIC_INVOICING',
      action: AuditAction.ELECTRONIC_DOCUMENT_CREATED,
      entityType: 'ElectronicDocument',
      entityId: created.id,
      description: `Documento fiscal ${command.documentType} ${command.series} creado para la venta ${sale.number}`,
      metadata: {
        documentType: command.documentType,
        series: command.series,
        number: allocation.number,
        saleNumber: sale.number,
        providerCode: this.provider.code,
      },
      ipAddress: command.ipAddress ?? null,
      client: tx,
    });

    return created.id;
  }

  /**
   * Lectura estrecha de Sale + SaleItem (§6/§14). Orden determinista
   * `createdAt ASC, id ASC`: SaleItem no tiene columna de posición explícita
   * (mismo esquema desde la Fase 6), así que se usa el mismo criterio de
   * desempate ya establecido en el resto del dominio (p. ej. Payment
   * `paidAt ASC, id ASC`) en vez de confiar en el orden físico no
   * especificado de PostgreSQL.
   */
  private async loadSaleSnapshot(
    tx: Prisma.TransactionClient,
    saleId: string,
  ): Promise<SaleFiscalSnapshot> {
    const sale = await tx.sale.findUnique({
      where: { id: saleId },
      select: {
        id: true,
        number: true,
        status: true,
        customerIsGeneric: true,
        customerDocumentType: true,
        customerDocumentNumber: true,
        customerName: true,
        customerAddress: true,
        subtotal: true,
        discountAmount: true,
        taxAmount: true,
        total: true,
        currencyCode: true,
        items: {
          select: {
            productSku: true,
            productName: true,
            unitCode: true,
            unitName: true,
            unitAbbreviation: true,
            quantity: true,
            unitPrice: true,
            lineTotal: true,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (sale === null) {
      throw new NotFoundException('La venta no existe');
    }
    return sale;
  }

  /**
   * Lee CompanySettings UNA vez para la identidad del emisor (§8/§12).
   * Deliberadamente NO usa SettingsReader (Configuración, Fase 10): ese
   * puerto expone solo moneda/IGV/vigencia/descuento, nunca identidad de la
   * empresa. taxId/address son nullable en el esquema hoy (Fase 11A #21: no
   * se agregan columnas nuevas a CompanySettings en este bloque), así que
   * null se trata igual que "en blanco".
   */
  private async loadAndValidateIssuer(
    tx: Prisma.TransactionClient,
  ): Promise<{ businessName: string; taxId: string; address: string }> {
    const row = await tx.companySettings.findUnique({
      where: { singleton: true },
      select: { businessName: true, taxId: true, address: true },
    });
    if (row === null) {
      // Invariante interna real (fila singleton ausente), no un caso de
      // negocio: mismo criterio que SettingsReader.getCurrent().
      throw new NotFoundException(
        'Configuración de la empresa no inicializada',
      );
    }

    const businessName = row.businessName.trim();
    if (businessName.length === 0) {
      throw new BadRequestException(
        'No se puede emitir el documento fiscal: el nombre de la empresa (businessName) está en blanco',
      );
    }

    const taxId = (row.taxId ?? '').trim();
    if (!RUC_PATTERN.test(taxId)) {
      throw new BadRequestException(
        'No se puede emitir el documento fiscal: el RUC de la empresa (taxId) debe tener exactamente 11 caracteres numéricos',
      );
    }

    const address = (row.address ?? '').trim();
    if (address.length === 0) {
      throw new BadRequestException(
        'No se puede emitir el documento fiscal: la dirección de la empresa está en blanco',
      );
    }

    return { businessName, taxId, address };
  }

  /**
   * Reglas de cliente por tipo de documento (§9/§10), evaluadas SOLO sobre
   * el snapshot ya congelado de Sale — nunca una relectura de Customer.
   */
  private validateCustomerForDocumentType(
    documentType: FiscalDocumentType,
    sale: SaleFiscalSnapshot,
  ): void {
    if (documentType === FiscalDocumentType.FACTURA) {
      if (sale.customerIsGeneric) {
        throw new ConflictException(
          'FACTURA no admite el cliente genérico "Público general"',
        );
      }
      if (sale.customerDocumentType !== CustomerDocumentType.RUC) {
        throw new ConflictException(
          'FACTURA requiere un cliente identificado con RUC',
        );
      }
      if (
        sale.customerDocumentNumber === null ||
        !RUC_PATTERN.test(sale.customerDocumentNumber)
      ) {
        throw new ConflictException(
          'El RUC del cliente debe tener exactamente 11 caracteres numéricos',
        );
      }
      if (sale.customerName.trim().length === 0) {
        throw new ConflictException(
          'El cliente debe tener un nombre válido para emitir FACTURA',
        );
      }
      return;
    }

    // BOLETA
    if (sale.currencyCode !== 'PEN') {
      // §10, decisión de diseño mínima y segura reportada explícitamente:
      // el umbral de S/700 no es evaluable sin una conversión de moneda
      // que este bloque NO implementa (bloqueador de producto genuino,
      // documentado en el reporte final en vez de inventar una tasa de
      // cambio). Se exige SIEMPRE identificación completa cuando la moneda
      // no es PEN, sin importar el monto.
      this.assertIdentifiedCustomer(sale);
      return;
    }

    if (sale.total.lessThanOrEqualTo(BOLETA_GENERIC_CUSTOMER_MAX_TOTAL)) {
      // Genérico o identificado, ambos admitidos por debajo/igual al umbral.
      return;
    }

    this.assertIdentifiedCustomer(sale);
  }

  private assertIdentifiedCustomer(sale: SaleFiscalSnapshot): void {
    if (sale.customerIsGeneric) {
      throw new ConflictException(
        'BOLETA por encima del umbral requiere un cliente identificado, no "Público general"',
      );
    }
    if (sale.customerDocumentType === null) {
      throw new ConflictException(
        'BOLETA por encima del umbral requiere el tipo de documento del cliente',
      );
    }
    if (
      sale.customerDocumentNumber === null ||
      sale.customerDocumentNumber.trim().length === 0
    ) {
      throw new ConflictException(
        'BOLETA por encima del umbral requiere el número de documento del cliente',
      );
    }
    if (sale.customerName.trim().length === 0) {
      throw new ConflictException(
        'BOLETA por encima del umbral requiere el nombre del cliente',
      );
    }
  }

  // ==================================================================
  // Fases 2-4 — tránsito a SUBMITTED, llamada al proveedor, resultado
  // (§24-§29)
  // ==================================================================

  private async runSubmissionFlow(
    documentId: string,
    allowedFromStatuses: ElectronicDocumentStatus[],
    actorUserId: string | null,
    ipAddress: string | null,
  ): Promise<ElectronicDocumentSnapshot> {
    const transitioned = await this.prisma.$transaction((tx) =>
      this.transitionToSubmitted(tx, documentId, allowedFromStatuses),
    );

    const payload = this.buildProviderPayload(transitioned);

    let result: ProviderSubmissionResult;
    try {
      result = await this.provider.submit(payload);
    } catch (error) {
      // §28: nunca se expone message/stack/cuerpo crudo del proveedor en
      // campos persistidos/públicos. El detalle completo solo va al log
      // del servidor, mismo criterio que AllExceptionsFilter.
      this.logger.error(
        `Fallo al enviar el documento fiscal ${transitioned.id} (${transitioned.documentType} ${transitioned.series}-${transitioned.number}) al proveedor ${this.provider.code}`,
        error instanceof Error ? error.stack : String(error),
      );

      // Remediación final del Bloque 11C: solo un error EXPLÍCITAMENTE
      // clasificado como retryable puede mover el documento a
      // SUBMISSION_FAILED. Cualquier otra excepción — incluida
      // UnknownProviderSubmissionOutcomeError y cualquier error genérico/no
      // reconocido del adaptador — se trata SIEMPRE como resultado
      // desconocido ("fail closed", §5): el proveedor pudo haber recibido y
      // procesado el documento sin que lleguemos a saberlo, así que nunca
      // es seguro habilitar un reintento automático. El documento queda
      // SUBMITTED, exactamente la misma semántica que la ventana de crash
      // ya documentada (§29/§15 de este bloque).
      if (error instanceof RetryableProviderSubmissionError) {
        await this.prisma.$transaction((tx) =>
          this.persistSubmissionFailed(
            tx,
            transitioned,
            actorUserId,
            ipAddress,
          ),
        );
      } else {
        await this.prisma.$transaction((tx) =>
          this.persistUnknownSubmissionOutcome(tx, transitioned),
        );
      }

      throw new ServiceUnavailableException(
        'No se pudo confirmar el resultado del envío del documento fiscal con el proveedor electrónico',
      );
    }

    return this.prisma.$transaction((tx) =>
      this.persistProviderOutcome(
        tx,
        transitioned,
        result,
        actorUserId,
        ipAddress,
      ),
    );
  }

  /**
   * Único punto que mueve un documento a SUBMITTED (§25): CREATED o
   * SUBMISSION_FAILED -> SUBMITTED, según qué orígenes permita el llamador
   * (`issue()` solo CREATED; `retrySubmission()` solo SUBMISSION_FAILED).
   * Un único UPDATE ... WHERE status IN (...) ... RETURNING: la propia
   * condición del UPDATE es el chequeo de estado, sin lectura previa que
   * luego se invalide por una carrera.
   */
  private async transitionToSubmitted(
    tx: Prisma.TransactionClient,
    documentId: string,
    allowedFromStatuses: ElectronicDocumentStatus[],
  ): Promise<ElectronicDocumentSafeRow> {
    const statusList = Prisma.join(
      allowedFromStatuses.map(
        (status) => Prisma.sql`${status}::"ElectronicDocumentStatus"`,
      ),
    );
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE electronic_documents
      SET
        status = 'SUBMITTED'::"ElectronicDocumentStatus",
        submission_count = submission_count + 1,
        last_submitted_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${documentId}::uuid AND status IN (${statusList})
      RETURNING id
    `);

    if (rows[0] === undefined) {
      const existing = await tx.electronicDocument.findUnique({
        where: { id: documentId },
        select: { status: true },
      });
      if (existing === null) {
        throw new NotFoundException('El documento fiscal no existe');
      }
      throw new ConflictException(
        `El documento fiscal está en estado ${existing.status}; no admite este envío`,
      );
    }

    return tx.electronicDocument.findUniqueOrThrow({
      where: { id: documentId },
      select: ELECTRONIC_DOCUMENT_SAFE_SELECT,
    });
  }

  private buildProviderPayload(
    row: ElectronicDocumentSafeRow,
  ): ElectronicDocumentSubmissionPayload {
    return {
      documentId: row.id,
      documentType: row.documentType,
      series: row.series,
      number: row.number,
      currencyCode: row.currencyCode,
      issuerTaxId: row.issuerTaxId,
      issuerBusinessName: row.issuerBusinessName,
      issuerAddress: row.issuerAddress,
      customerDocumentType: row.customerDocumentType,
      customerDocumentNumber: row.customerDocumentNumber,
      customerName: row.customerName,
      customerAddress: row.customerAddress,
      subtotal: row.subtotal.toFixed(2),
      discountAmount: row.discountAmount.toFixed(2),
      taxableBase: row.taxableBase.toFixed(2),
      taxAmount: row.taxAmount.toFixed(2),
      total: row.total.toFixed(2),
      items: row.items.map((item) => ({
        lineNumber: item.lineNumber,
        productSku: item.productSku,
        description: item.description,
        unitCode: item.unitCode,
        unitName: item.unitName,
        unitAbbreviation: item.unitAbbreviation,
        quantity: item.quantity.toFixed(3),
        unitPrice: item.unitPrice.toFixed(2),
        lineTotal: item.lineTotal.toFixed(2),
      })),
    };
  }

  /** §28: SUBMITTED -> SUBMISSION_FAILED. Nunca toca el número/serie/snapshot ya persistidos. */
  private async persistSubmissionFailed(
    tx: Prisma.TransactionClient,
    doc: ElectronicDocumentSafeRow,
    actorUserId: string | null,
    ipAddress: string | null,
  ): Promise<void> {
    const sale = await tx.sale.findUniqueOrThrow({
      where: { id: doc.saleId },
      select: { number: true },
    });

    await tx.electronicDocument.update({
      where: { id: doc.id },
      data: {
        status: ElectronicDocumentStatus.SUBMISSION_FAILED,
        providerStatus: 'TECHNICAL_FAILURE',
        providerMessage:
          'Fallo técnico de comunicación con el proveedor electrónico.',
        acceptedAt: null,
        rejectedAt: null,
      },
    });

    await this.auditService.record({
      userId: actorUserId,
      module: 'ELECTRONIC_INVOICING',
      action: AuditAction.ELECTRONIC_DOCUMENT_SUBMISSION_FAILED,
      entityType: 'ElectronicDocument',
      entityId: doc.id,
      description: `Fallo técnico al enviar el documento fiscal ${doc.documentType} ${doc.series}-${doc.number} de la venta ${sale.number}`,
      metadata: {
        documentType: doc.documentType,
        series: doc.series,
        number: doc.number,
        saleNumber: sale.number,
        providerCode: doc.providerCode,
        providerStatus: 'TECHNICAL_FAILURE',
      },
      ipAddress,
      client: tx,
    });
  }

  /**
   * §5/§7 (remediación final del Bloque 11C): resultado de envío
   * DESCONOCIDO — ni RetryableProviderSubmissionError ni ningún outcome
   * ACCEPTED/REJECTED confirmado. El documento permanece EXACTAMENTE en
   * SUBMITTED (no se toca `status`): nunca se clasifica como
   * SUBMISSION_FAILED sin la certeza explícita del adaptador de que el
   * proveedor no recibió/procesó el documento. Sin AuditAction nueva (§8,
   * decisión de este bloque: la arquitectura exhaustiva de auditoría no
   * exige una acción dedicada para un diagnóstico interno que no cambia el
   * estado del documento); el detalle completo ya quedó en el log del
   * servidor. Solo se persiste diagnóstico seguro y genérico en las
   * columnas ya existentes — nunca el mensaje/stack crudo del error.
   */
  private async persistUnknownSubmissionOutcome(
    tx: Prisma.TransactionClient,
    doc: ElectronicDocumentSafeRow,
  ): Promise<void> {
    await tx.electronicDocument.update({
      where: { id: doc.id },
      data: {
        providerStatus: 'UNKNOWN_OUTCOME',
        providerMessage:
          'No se pudo confirmar la respuesta del proveedor electrónico; resultado desconocido, pendiente de reconciliación.',
        acceptedAt: null,
        rejectedAt: null,
      },
    });
  }

  /** §26/§27: SUBMITTED -> ACCEPTED o REJECTED, con auditoría atómica. */
  private async persistProviderOutcome(
    tx: Prisma.TransactionClient,
    doc: ElectronicDocumentSafeRow,
    result: ProviderSubmissionResult,
    actorUserId: string | null,
    ipAddress: string | null,
  ): Promise<ElectronicDocumentSnapshot> {
    const sale = await tx.sale.findUniqueOrThrow({
      where: { id: doc.saleId },
      select: { number: true },
    });

    const isAccepted = result.outcome === 'ACCEPTED';
    const now = new Date();

    const updated = await tx.electronicDocument.update({
      where: { id: doc.id },
      data: {
        status: isAccepted
          ? ElectronicDocumentStatus.ACCEPTED
          : ElectronicDocumentStatus.REJECTED,
        providerExternalId: result.externalId,
        providerStatus: result.providerStatus,
        providerMessage: result.providerMessage,
        acceptedAt: isAccepted ? now : null,
        rejectedAt: isAccepted ? null : now,
      },
      select: ELECTRONIC_DOCUMENT_SAFE_SELECT,
    });

    await this.auditService.record({
      userId: actorUserId,
      module: 'ELECTRONIC_INVOICING',
      action: isAccepted
        ? AuditAction.ELECTRONIC_DOCUMENT_ACCEPTED
        : AuditAction.ELECTRONIC_DOCUMENT_REJECTED,
      entityType: 'ElectronicDocument',
      entityId: doc.id,
      description: `Documento fiscal ${doc.documentType} ${doc.series}-${doc.number} de la venta ${sale.number} ${isAccepted ? 'aceptado' : 'rechazado'} por el proveedor`,
      metadata: {
        documentType: doc.documentType,
        series: doc.series,
        number: doc.number,
        saleNumber: sale.number,
        providerCode: doc.providerCode,
        providerStatus: result.providerStatus,
      },
      ipAddress,
      client: tx,
    });

    return toElectronicDocumentSnapshot(updated);
  }
}

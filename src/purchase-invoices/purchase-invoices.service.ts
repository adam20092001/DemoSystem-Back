import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountingSourceType,
  Prisma,
  PurchaseAcquisitionKind,
  PurchaseInvoiceStatus,
  PurchaseLineTaxBasis,
  PurchaseLineTaxCategory,
  PurchasePurpose,
  RoleName,
  SupplierStatus,
} from '@prisma/client';
import { AccountingEngine } from '../accounting/accounting.engine';
import { buildPurchaseOriginalDescription } from '../accounting/accounting-calculator';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import {
  businessToday,
  fromPrismaDate,
  isValidDateOnly,
  toPrismaDate,
} from '../common/date/business-date';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import { SettingsReader } from '../configuration/settings-reader.service';
import {
  PURCHASE_INVOICE_SAFE_SELECT,
  toSafePurchaseInvoice,
} from './mappers/purchase-invoice.mapper';
import {
  buildPurchaseRecognitionLines,
  calculatePurchaseInvoiceTotals,
  computePurchaseLineAmounts,
} from './purchase-invoice-calculator';
import {
  CancelPurchaseInvoiceInput,
  ConfirmPurchaseInvoiceInput,
} from './types/purchase-invoice-action.input';
import {
  CreatePurchaseInvoiceInput,
  CreatePurchaseInvoiceLineInput,
} from './types/create-purchase-invoice.input';
import { ListPurchaseInvoicesQuery } from './types/list-purchase-invoices.query';
import { SafePurchaseInvoice } from './types/safe-purchase-invoice';
import { UpdatePurchaseInvoiceInput } from './types/update-purchase-invoice.input';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** ADMIN/MANAGEMENT/ACCOUNTANT leen; SELLER/WAREHOUSE sin ningún acceso nuevo (A5.2a kickoff, §11). */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
]);

/** Solo ADMIN administra el ciclo de vida completo en esta fase (A5.2a kickoff, §11). */
const MANAGE_ROLES: ReadonlySet<RoleName> = new Set([RoleName.ADMIN]);

function assertCanRead(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar facturas de compra',
    );
  }
}

function assertCanManage(requesterRole: RoleName): void {
  if (!MANAGE_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para administrar facturas de compra',
    );
  }
}

interface LockedInvoiceRow {
  id: string;
  status: PurchaseInvoiceStatus;
  postedEntryId: string | null;
  documentType: string;
  documentSeries: string | null;
  documentNumber: string;
}

interface PreparedLine {
  productId: string | null;
  descriptionSnapshot: string;
  unitCodeSnapshot: string | null;
  unitNameSnapshot: string | null;
  acquisitionKind: PurchaseAcquisitionKind;
  purchasePurpose: PurchasePurpose;
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  taxCategory: PurchaseLineTaxCategory;
  taxBasis: PurchaseLineTaxBasis | null;
  taxRateSnapshot: Prisma.Decimal | null;
  taxableBaseAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  creditableTaxAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

/**
 * Ciclo de vida de facturas de compra universales (Fase A5.2a):
 * crear/editar/listar/consultar (este servicio), confirmar y anular
 * (delegando el posteo/reversión REAL siempre a AccountingEngine, que
 * sigue siendo el único escritor de AccountingEntry/AccountingEntryLine —
 * este servicio NUNCA escribe esas tablas directamente). NUNCA modifica
 * inventario (StockMovementEngine/InventoryMovement/Product.stockCurrent
 * sin cambios aquí): esa es responsabilidad exclusiva de una futura Fase
 * A5.2b, todavía no implementada.
 */
@Injectable()
export class PurchaseInvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly accountingEngine: AccountingEngine,
    private readonly settingsReader: SettingsReader,
  ) {}

  // ==================================================================
  // Lectura
  // ==================================================================

  async listDrafts(
    query: ListPurchaseInvoicesQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafePurchaseInvoice>> {
    assertCanRead(requesterRole);

    const page =
      query.page !== undefined && query.page > 0
        ? Math.floor(query.page)
        : DEFAULT_PAGE;
    const limit = Math.min(
      query.limit !== undefined && query.limit > 0
        ? Math.floor(query.limit)
        : DEFAULT_LIMIT,
      MAX_LIMIT,
    );
    const skip = (page - 1) * limit;

    const where: Prisma.PurchaseInvoiceWhereInput = {};
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.documentType !== undefined) {
      where.documentType = query.documentType;
    }
    if (query.supplierId !== undefined) {
      where.supplierId = query.supplierId;
    }
    const term = query.search?.trim();
    if (term !== undefined && term.length > 0) {
      where.OR = [
        { documentNumber: { contains: term, mode: 'insensitive' } },
        { documentSeries: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.purchaseInvoice.findMany({
        where,
        select: PURCHASE_INVOICE_SAFE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.purchaseInvoice.count({ where }),
    ]);

    return {
      data: rows.map(toSafePurchaseInvoice),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findOne(
    purchaseInvoiceId: string,
    requesterRole: RoleName,
  ): Promise<SafePurchaseInvoice> {
    assertCanRead(requesterRole);
    const row = await this.prisma.purchaseInvoice.findUnique({
      where: { id: purchaseInvoiceId },
      select: PURCHASE_INVOICE_SAFE_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('Factura de compra no encontrada');
    }
    return toSafePurchaseInvoice(row);
  }

  // ==================================================================
  // Escritura — borrador (A5.2a)
  // ==================================================================

  async create(
    input: CreatePurchaseInvoiceInput,
  ): Promise<SafePurchaseInvoice> {
    assertCanManage(input.requesterRole);

    const issueDate = this.normalizeDateOnly(input.issueDate, 'issueDate');
    const registrationDate = this.normalizeDateOnly(
      input.registrationDate ?? businessToday(),
      'registrationDate',
    );
    const accountingDate = this.normalizeDateOnly(
      input.accountingDate ?? businessToday(),
      'accountingDate',
    );
    const dueDate =
      input.dueDate !== undefined
        ? this.normalizeDateOnly(input.dueDate, 'dueDate')
        : null;
    const documentSeries = this.normalizeOptionalCode(input.documentSeries);
    const documentNumber = this.normalizeRequiredCode(
      input.documentNumber,
      'documentNumber',
    );

    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUnique({
        where: { id: input.supplierId },
        select: { id: true, status: true },
      });
      if (supplier === null) {
        throw new BadRequestException('El proveedor indicado no existe');
      }
      if (supplier.status !== SupplierStatus.ACTIVE) {
        throw new ConflictException('El proveedor indicado no está activo');
      }

      // A0.2 (mismo criterio exacto que SalesService.createDirect()):
      // bloquea la fila singleton de configuración ANTES de leer
      // currencyCode/taxEnabled/taxRate, para que un cambio de moneda
      // concurrente nunca produzca un estado mixto.
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM company_settings WHERE singleton = true FOR UPDATE`,
      );
      const settings = await this.settingsReader.getCurrent(tx);

      const lines = await this.prepareLines(
        tx,
        input.lines,
        settings.taxEnabled,
        settings.taxRate,
      );
      const totals = calculatePurchaseInvoiceTotals(lines);

      const created = await tx.purchaseInvoice.create({
        data: {
          supplierId: input.supplierId,
          documentType: input.documentType,
          documentSeries,
          documentNumber,
          issueDate,
          registrationDate,
          accountingDate,
          dueDate,
          paymentTermsDays: input.paymentTermsDays ?? null,
          currencyCode: settings.currencyCode,
          subtotal: totals.subtotal,
          taxAmount: totals.taxAmount,
          totalAmount: totals.totalAmount,
          createdByUserId: input.actorUserId,
          lines: {
            create: lines.map((line) => this.toLineCreateData(line)),
          },
        },
        select: PURCHASE_INVOICE_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PURCHASE_INVOICES',
        action: AuditAction.PURCHASE_INVOICE_CREATED,
        entityType: 'PurchaseInvoice',
        entityId: created.id,
        description: `Factura de compra ${created.id} creada`,
        metadata: {
          supplierId: input.supplierId,
          documentType: input.documentType,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafePurchaseInvoice(created);
    });
  }

  /**
   * PATCH con reemplazo COMPLETO de `lines` cuando se provee (mismo
   * criterio que ManualJournalDraft, A4.2). Bloqueado por fila: la misma
   * fila que confirm()/cancel() bloquean, así que edición y confirmación
   * de UNA MISMA factura nunca se intercalan de forma inconsistente.
   */
  async update(
    input: UpdatePurchaseInvoiceInput,
  ): Promise<SafePurchaseInvoice> {
    assertCanManage(input.requesterRole);

    const hasAnyField =
      input.documentType !== undefined ||
      input.documentSeries !== undefined ||
      input.documentNumber !== undefined ||
      input.issueDate !== undefined ||
      input.registrationDate !== undefined ||
      input.accountingDate !== undefined ||
      input.dueDate !== undefined ||
      input.paymentTermsDays !== undefined ||
      input.lines !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockInvoice(tx, input.purchaseInvoiceId);
      if (locked.status !== PurchaseInvoiceStatus.DRAFT) {
        throw new ConflictException(
          'Solo se puede editar una factura de compra mientras está en estado DRAFT',
        );
      }

      const data: Prisma.PurchaseInvoiceUpdateInput = {};

      if (input.documentType !== undefined) {
        data.documentType = input.documentType;
      }
      if (input.documentSeries !== undefined) {
        data.documentSeries = this.normalizeOptionalCode(input.documentSeries);
      }
      if (input.documentNumber !== undefined) {
        data.documentNumber = this.normalizeRequiredCode(
          input.documentNumber,
          'documentNumber',
        );
      }
      if (input.issueDate !== undefined) {
        data.issueDate = this.normalizeDateOnly(input.issueDate, 'issueDate');
      }
      if (input.registrationDate !== undefined) {
        data.registrationDate = this.normalizeDateOnly(
          input.registrationDate,
          'registrationDate',
        );
      }
      if (input.accountingDate !== undefined) {
        data.accountingDate = this.normalizeDateOnly(
          input.accountingDate,
          'accountingDate',
        );
      }
      if (input.dueDate !== undefined) {
        data.dueDate =
          input.dueDate === null
            ? null
            : this.normalizeDateOnly(input.dueDate, 'dueDate');
      }
      if (input.paymentTermsDays !== undefined) {
        data.paymentTermsDays = input.paymentTermsDays;
      }

      if (input.lines !== undefined) {
        const settings = await this.settingsReader.getCurrent(tx);
        const lines = await this.prepareLines(
          tx,
          input.lines,
          settings.taxEnabled,
          settings.taxRate,
        );
        const totals = calculatePurchaseInvoiceTotals(lines);
        data.subtotal = totals.subtotal;
        data.taxAmount = totals.taxAmount;
        data.totalAmount = totals.totalAmount;

        await tx.purchaseInvoiceLine.deleteMany({
          where: { purchaseInvoiceId: locked.id },
        });
        await tx.purchaseInvoiceLine.createMany({
          data: lines.map((line) => ({
            purchaseInvoiceId: locked.id,
            ...this.toLineCreateData(line),
          })),
        });
      }

      if (Object.keys(data).length > 0) {
        await tx.purchaseInvoice.update({ where: { id: locked.id }, data });
      }

      const updated = await tx.purchaseInvoice.findUniqueOrThrow({
        where: { id: locked.id },
        select: PURCHASE_INVOICE_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PURCHASE_INVOICES',
        action: AuditAction.PURCHASE_INVOICE_UPDATED,
        entityType: 'PurchaseInvoice',
        entityId: locked.id,
        description: `Factura de compra ${locked.id} actualizada`,
        metadata: { updatedFieldCount: Object.keys(data).length },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafePurchaseInvoice(updated);
    });
  }

  // ==================================================================
  // Confirmación (A5.2a)
  // ==================================================================

  async confirm(
    input: ConfirmPurchaseInvoiceInput,
  ): Promise<SafePurchaseInvoice> {
    assertCanManage(input.requesterRole);

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockInvoice(tx, input.purchaseInvoiceId);
      if (locked.status !== PurchaseInvoiceStatus.DRAFT) {
        throw new ConflictException(
          'Solo se puede confirmar una factura de compra en estado DRAFT',
        );
      }

      const invoice = await tx.purchaseInvoice.findUniqueOrThrow({
        where: { id: locked.id },
        include: { lines: true, supplier: { select: { status: true } } },
      });

      if (invoice.supplier.status !== SupplierStatus.ACTIVE) {
        throw new ConflictException(
          'No se puede confirmar: el proveedor de esta factura no está activo',
        );
      }
      if (invoice.lines.length === 0) {
        throw new BadRequestException(
          'La factura debe tener al menos una línea antes de confirmarse',
        );
      }

      // Dimensión C congelada (riesgo de mutabilidad identificado en la
      // revisión de A5.2): se calcula EXACTAMENTE AQUÍ, a partir de
      // Product.isInventoryTracked vigente en este instante, y nunca se
      // vuelve a derivar después — A5.2b (todavía no implementada)
      // consumirá este valor ya congelado, sin releer Product.
      const productIds = Array.from(
        new Set(
          invoice.lines
            .map((line) => line.productId)
            .filter((id): id is string => id !== null),
        ),
      );
      const products =
        productIds.length > 0
          ? await tx.product.findMany({
              where: { id: { in: productIds } },
              select: { id: true, isInventoryTracked: true },
            })
          : [];
      const trackedProductIds = new Set(
        products.filter((p) => p.isInventoryTracked).map((p) => p.id),
      );

      for (const line of invoice.lines) {
        const isReceiptEligible =
          line.acquisitionKind === PurchaseAcquisitionKind.GOOD &&
          line.productId !== null &&
          trackedProductIds.has(line.productId);
        await tx.purchaseInvoiceLine.update({
          where: { id: line.id },
          data: { isReceiptEligible },
        });
      }

      const recognitionLines = buildPurchaseRecognitionLines(
        invoice.lines.map((line) => ({
          purchasePurpose: line.purchasePurpose,
          taxableBaseAmount: line.taxableBaseAmount,
          taxAmount: line.taxAmount,
          creditableTaxAmount: line.creditableTaxAmount,
        })),
      );

      const documentLabel = this.formatDocumentLabel(
        invoice.documentType,
        invoice.documentSeries,
        invoice.documentNumber,
      );

      const posted = await this.accountingEngine.postPurchaseRecognition(tx, {
        purchaseInvoiceId: invoice.id,
        description: buildPurchaseOriginalDescription(documentLabel),
        accountingDateOnly: fromPrismaDate(invoice.accountingDate),
        lines: recognitionLines,
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress,
      });

      const updated = await tx.purchaseInvoice.update({
        where: { id: invoice.id },
        data: {
          status: PurchaseInvoiceStatus.CONFIRMED,
          confirmedAt: new Date(),
          postedEntryId: posted.id,
        },
        select: PURCHASE_INVOICE_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PURCHASE_INVOICES',
        action: AuditAction.PURCHASE_INVOICE_CONFIRMED,
        entityType: 'PurchaseInvoice',
        entityId: invoice.id,
        description: `Factura de compra ${documentLabel} contabilizada`,
        metadata: { entryId: posted.id, journalNumber: posted.journalNumber },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafePurchaseInvoice(updated);
    });
  }

  // ==================================================================
  // Anulación (A5.2a)
  // ==================================================================

  /**
   * A5.2a nunca tiene PurchaseReceipt (todavía no existe): no hay ningún
   * chequeo de "recepciones activas" que bloquear aquí — esa guardia es
   * responsabilidad exclusiva de una futura Fase A5.2b, que deberá
   * agregarla ANTES de permitir esta anulación cuando ya existan
   * recepciones.
   */
  async cancel(
    input: CancelPurchaseInvoiceInput,
  ): Promise<SafePurchaseInvoice> {
    assertCanManage(input.requesterRole);

    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new BadRequestException('reason es obligatorio');
    }
    if (reason.length > 300) {
      throw new BadRequestException(
        'reason no puede superar los 300 caracteres',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockInvoice(tx, input.purchaseInvoiceId);
      if (locked.status !== PurchaseInvoiceStatus.CONFIRMED) {
        throw new ConflictException(
          'Solo se puede anular una factura de compra ya CONFIRMED',
        );
      }

      // Fase A5.2b: una factura con recepciones ACTIVE nunca se anula
      // automáticamente en cascada — el usuario debe anular primero cada
      // recepción. Verificado DESPUÉS del lock de fila de arriba (mismo
      // `purchase_invoices` FOR UPDATE que PurchaseReceiptsService.create()
      // toma antes de crear una recepción nueva): ambas rutas quedan
      // serializadas entre sí sin lock adicional ni riesgo de deadlock
      // (mismo orden de locks siempre — la factura primero).
      const activeReceiptsCount = await tx.purchaseReceipt.count({
        where: { purchaseInvoiceId: locked.id, status: 'ACTIVE' },
      });
      if (activeReceiptsCount > 0) {
        throw new ConflictException(
          'No se puede anular: existen recepciones activas para esta factura. Anule primero cada recepción.',
        );
      }

      const documentLabel = this.formatDocumentLabel(
        locked.documentType,
        locked.documentSeries,
        locked.documentNumber,
      );

      const reversal = await this.accountingEngine.reverseOriginalForSource(
        tx,
        {
          sourceType: AccountingSourceType.PURCHASE,
          sourceId: locked.id,
          sourceNumber: documentLabel,
          postedAt: new Date(),
          actorUserId: input.actorUserId,
          ipAddress: input.ipAddress,
        },
      );

      const updated = await tx.purchaseInvoice.update({
        where: { id: locked.id },
        data: {
          status: PurchaseInvoiceStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledByUserId: input.actorUserId,
          cancellationReason: reason,
        },
        select: PURCHASE_INVOICE_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PURCHASE_INVOICES',
        action: AuditAction.PURCHASE_INVOICE_CANCELLED,
        entityType: 'PurchaseInvoice',
        entityId: locked.id,
        description: `Factura de compra ${documentLabel} anulada`,
        metadata: { reversalEntryId: reversal.id, reason },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafePurchaseInvoice(updated);
    });
  }

  // ==================================================================
  // Helpers privados
  // ==================================================================

  private async lockInvoice(
    tx: Prisma.TransactionClient,
    purchaseInvoiceId: string,
  ): Promise<LockedInvoiceRow> {
    const rows = await tx.$queryRaw<LockedInvoiceRow[]>(Prisma.sql`
      SELECT id, status, posted_entry_id AS "postedEntryId",
             document_type AS "documentType",
             document_series AS "documentSeries",
             document_number AS "documentNumber"
      FROM purchase_invoices
      WHERE id = ${purchaseInvoiceId}::uuid
      FOR UPDATE
    `);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('Factura de compra no encontrada');
    }
    return row;
  }

  /**
   * Validación de EXISTENCIA pura para productId (A5.2a, mismo criterio
   * que ManualJournalEntriesService.assertAccountsExist(), A4.2): cualquier
   * producto real, activo o no — A5.2a nunca exige que esté ACTIVE (eso
   * es irrelevante mientras no se mueva inventario; A5.2b deberá validarlo
   * en el momento de recibir, no aquí).
   */
  private async prepareLines(
    tx: Prisma.TransactionClient,
    lines: CreatePurchaseInvoiceLineInput[],
    taxEnabled: boolean,
    companyTaxRate: Prisma.Decimal,
  ): Promise<PreparedLine[]> {
    const productIds = Array.from(
      new Set(
        lines
          .map((line) => line.productId)
          .filter((id): id is string => id !== undefined),
      ),
    );
    const products =
      productIds.length > 0
        ? await tx.product.findMany({
            where: { id: { in: productIds } },
            select: {
              id: true,
              name: true,
              unit: { select: { code: true, name: true } },
            },
          })
        : [];
    const productsById = new Map(products.map((p) => [p.id, p]));
    for (const id of productIds) {
      if (!productsById.has(id)) {
        throw new BadRequestException(`El producto ${id} no existe`);
      }
    }

    return lines.map((line) => {
      const product =
        line.productId !== undefined
          ? productsById.get(line.productId)
          : undefined;

      let descriptionSnapshot: string;
      if (line.description !== undefined && line.description.trim() !== '') {
        descriptionSnapshot = line.description.trim();
      } else if (product !== undefined) {
        descriptionSnapshot = product.name;
      } else {
        throw new BadRequestException(
          'description es obligatoria cuando la línea no referencia un productId',
        );
      }

      const unitCodeSnapshot = product?.unit.code ?? null;
      const unitNameSnapshot =
        product?.unit.name ?? line.unitLabel?.trim() ?? null;

      const taxCategory = line.taxCategory;
      let taxBasis: CreatePurchaseInvoiceLineInput['taxBasis'] | undefined =
        line.taxBasis;
      let taxRate: Prisma.Decimal | null = null;

      if (taxCategory === PurchaseLineTaxCategory.TAXED) {
        if (!taxEnabled) {
          throw new BadRequestException(
            'No se puede declarar una línea con taxCategory=TAXED mientras el IGV de la empresa está desactivado',
          );
        }
        if (taxBasis === undefined) {
          throw new BadRequestException(
            'taxBasis es obligatorio cuando taxCategory=TAXED',
          );
        }
        taxRate = companyTaxRate;
      } else {
        taxBasis = undefined;
      }

      const quantity = this.parseDecimalInput(line.quantity, 'quantity');
      const unitCost = this.parseDecimalInput(line.unitCost, 'unitCost');
      const creditableTaxAmountInput =
        line.creditableTaxAmount !== undefined
          ? this.parseDecimalInput(
              line.creditableTaxAmount,
              'creditableTaxAmount',
            )
          : new Prisma.Decimal(0);

      const amounts = computePurchaseLineAmounts({
        quantity,
        unitCost,
        taxCategory,
        taxBasis: taxBasis ?? null,
        taxRate,
        creditableTaxAmount: creditableTaxAmountInput,
      });

      return {
        productId: line.productId ?? null,
        descriptionSnapshot,
        unitCodeSnapshot,
        unitNameSnapshot,
        acquisitionKind: line.acquisitionKind,
        purchasePurpose: line.purchasePurpose,
        quantity,
        unitCost,
        taxCategory,
        taxBasis: taxBasis ?? null,
        taxRateSnapshot: taxRate,
        taxableBaseAmount: amounts.taxableBaseAmount,
        taxAmount: amounts.taxAmount,
        creditableTaxAmount: amounts.creditableTaxAmount,
        lineTotal: amounts.lineTotal,
      };
    });
  }

  private toLineCreateData(
    line: PreparedLine,
  ): Prisma.PurchaseInvoiceLineCreateManyPurchaseInvoiceInput {
    return {
      productId: line.productId,
      descriptionSnapshot: line.descriptionSnapshot,
      unitCodeSnapshot: line.unitCodeSnapshot,
      unitNameSnapshot: line.unitNameSnapshot,
      acquisitionKind: line.acquisitionKind,
      purchasePurpose: line.purchasePurpose,
      quantity: line.quantity,
      unitCost: line.unitCost,
      taxCategory: line.taxCategory,
      taxBasis: line.taxBasis,
      taxRateSnapshot: line.taxRateSnapshot,
      taxableBaseAmount: line.taxableBaseAmount,
      taxAmount: line.taxAmount,
      creditableTaxAmount: line.creditableTaxAmount,
      lineTotal: line.lineTotal,
    };
  }

  private parseDecimalInput(raw: string, fieldName: string): Prisma.Decimal {
    try {
      return new Prisma.Decimal(raw);
    } catch {
      throw new BadRequestException(`${fieldName} no es un decimal válido`);
    }
  }

  private normalizeDateOnly(raw: string, fieldName: string): Date {
    if (!isValidDateOnly(raw)) {
      throw new BadRequestException(
        `${fieldName} debe ser una fecha real en formato YYYY-MM-DD`,
      );
    }
    return toPrismaDate(raw);
  }

  private normalizeRequiredCode(raw: string, fieldName: string): string {
    const trimmed = raw.trim().toUpperCase();
    if (trimmed.length === 0) {
      throw new BadRequestException(`${fieldName} no puede estar vacío`);
    }
    return trimmed;
  }

  private normalizeOptionalCode(raw: string | null | undefined): string | null {
    if (raw === undefined || raw === null) {
      return null;
    }
    const trimmed = raw.trim().toUpperCase();
    return trimmed.length > 0 ? trimmed : null;
  }

  private formatDocumentLabel(
    documentType: string,
    documentSeries: string | null,
    documentNumber: string,
  ): string {
    const number =
      documentSeries !== null
        ? `${documentSeries}-${documentNumber}`
        : documentNumber;
    return `${documentType} ${number}`;
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountStatus,
  AccountingSourceType,
  AccountingSystemKey,
  InventoryMovementOrigin,
  InventoryMovementType,
  Prisma,
  PurchaseInvoiceStatus,
  PurchasePurpose,
  RoleName,
} from '@prisma/client';
import { AccountingEngine } from '../accounting/accounting.engine';
import { buildPurchaseReceiptReclassificationDescription } from '../accounting/accounting-calculator';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import {
  businessToday,
  isValidDateOnly,
  toPrismaDate,
} from '../common/date/business-date';
import { PrismaService } from '../database/prisma.service';
import { StockMovementEngine } from '../inventory/stock-movement.engine';
import { InventoryValuationEngine } from '../inventory-valuation/inventory-valuation.engine';
import { PURCHASE_PURPOSE_TO_SYSTEM_KEY } from '../purchase-invoices/purchase-invoice-calculator';
import {
  computeLineDestinationAmount,
  computeProportionalReclassificationAmount,
} from './purchase-receipt-calculator';
import {
  PURCHASE_RECEIPT_SAFE_SELECT,
  toSafePurchaseReceipt,
} from './mappers/purchase-receipt.mapper';
import { computeReceiptLineStatus } from './receipt-line-status';
import { CancelPurchaseReceiptInput } from './types/cancel-purchase-receipt.input';
import {
  CreatePurchaseReceiptInput,
  CreatePurchaseReceiptLineInput,
} from './types/create-purchase-receipt.input';
import { PurchaseInvoiceReceiptsSummary } from './types/purchase-invoice-receipts-summary';
import { SafePurchaseReceipt } from './types/safe-purchase-receipt';

const ZERO = new Prisma.Decimal(0);

/** Referencia de documento para StockMovementEngine/InventoryMovement — mismo criterio que SALE_REFERENCE_TYPE en sales.service.ts. */
const PURCHASE_RECEIPT_REFERENCE_TYPE = 'PurchaseReceipt';

/** ADMIN administra el ciclo de vida completo; MANAGEMENT/ACCOUNTANT solo leen. SELLER/WAREHOUSE sin ningún acceso nuevo (A5.2b kickoff). */
const MANAGE_ROLES: ReadonlySet<RoleName> = new Set([RoleName.ADMIN]);
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
]);

function assertCanRead(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar recepciones de compra',
    );
  }
}

function assertCanManage(requesterRole: RoleName): void {
  if (!MANAGE_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para administrar recepciones de compra',
    );
  }
}

interface LockedPurchaseInvoiceRow {
  id: string;
  status: PurchaseInvoiceStatus;
  postedEntryId: string | null;
  documentType: string;
  documentSeries: string | null;
  documentNumber: string;
}

interface LockedInvoiceLineRow {
  id: string;
  purchaseInvoiceId: string;
  isReceiptEligible: boolean | null;
  quantity: Prisma.Decimal;
  productId: string | null;
  purchasePurpose: PurchasePurpose;
  taxableBaseAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  creditableTaxAmount: Prisma.Decimal;
}

interface ReclassificationPlanItem {
  lineId: string;
  sourceAccountId: string;
  targetAccountId: string;
  amount: Prisma.Decimal;
}

/**
 * Recepciones físicas de mercadería (Fase A5.2b): independientes en el
 * tiempo de PurchaseInvoicesService.confirm() (A5.2a ya reconoce
 * contablemente la factura completa al confirmarse). Este servicio NUNCA
 * escribe AccountingEntry/AccountingEntryLine ni InventoryMovement/
 * Product.stockCurrent directamente — siempre delega en AccountingEngine/
 * StockMovementEngine, los únicos escritores de cada dominio.
 */
@Injectable()
export class PurchaseReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly stockMovementEngine: StockMovementEngine,
    private readonly accountingEngine: AccountingEngine,
    private readonly inventoryValuationEngine: InventoryValuationEngine,
  ) {}

  // ==================================================================
  // Lectura
  // ==================================================================

  async findOne(
    purchaseReceiptId: string,
    requesterRole: RoleName,
  ): Promise<SafePurchaseReceipt> {
    assertCanRead(requesterRole);
    const row = await this.prisma.purchaseReceipt.findUnique({
      where: { id: purchaseReceiptId },
      select: PURCHASE_RECEIPT_SAFE_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('Recepción de compra no encontrada');
    }
    return toSafePurchaseReceipt(row);
  }

  /**
   * Historial de recepciones de una factura + resumen pendiente/parcial/
   * completo por línea elegible — ambos calculados en tiempo de lectura,
   * nunca desde una columna duplicada en PurchaseInvoiceLine.
   */
  async listByInvoice(
    purchaseInvoiceId: string,
    requesterRole: RoleName,
  ): Promise<PurchaseInvoiceReceiptsSummary> {
    assertCanRead(requesterRole);

    const invoice = await this.prisma.purchaseInvoice.findUnique({
      where: { id: purchaseInvoiceId },
      select: {
        id: true,
        lines: {
          select: { id: true, quantity: true, isReceiptEligible: true },
        },
      },
    });
    if (invoice === null) {
      throw new NotFoundException('Factura de compra no encontrada');
    }

    const [receiptRows, receivedSums] = await Promise.all([
      this.prisma.purchaseReceipt.findMany({
        where: { purchaseInvoiceId },
        select: PURCHASE_RECEIPT_SAFE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.purchaseReceiptLine.groupBy({
        by: ['purchaseInvoiceLineId'],
        where: {
          purchaseInvoiceLineId: { in: invoice.lines.map((l) => l.id) },
          purchaseReceipt: { status: 'ACTIVE' },
        },
        _sum: { quantity: true },
      }),
    ]);
    const receivedMap = new Map(
      receivedSums.map((r) => [
        r.purchaseInvoiceLineId,
        r._sum.quantity ?? ZERO,
      ]),
    );

    const lines = invoice.lines
      .filter((l) => l.isReceiptEligible === true)
      .map((l) => {
        const received = receivedMap.get(l.id) ?? ZERO;
        const pending = l.quantity.minus(received);
        return {
          purchaseInvoiceLineId: l.id,
          invoicedQuantity: l.quantity.toFixed(3),
          receivedQuantity: received.toFixed(3),
          pendingQuantity: (pending.lessThan(0) ? ZERO : pending).toFixed(3),
          status: computeReceiptLineStatus(received, l.quantity),
        };
      });

    return {
      purchaseInvoiceId,
      receipts: receiptRows.map(toSafePurchaseReceipt),
      lines,
    };
  }

  // ==================================================================
  // Creación
  // ==================================================================

  async create(
    input: CreatePurchaseReceiptInput,
  ): Promise<SafePurchaseReceipt> {
    assertCanManage(input.requesterRole);

    const receivedDateString = input.receivedDate ?? businessToday();
    const receivedDate = this.normalizeDateOnly(
      receivedDateString,
      'receivedDate',
    );
    if (input.lines.length === 0) {
      throw new BadRequestException(
        'Debe incluir al menos una línea en la recepción',
      );
    }
    const requested = this.normalizeRequestedLines(input.lines);
    const notes = this.normalizeNotes(input.notes);
    const idempotencyKey = this.normalizeIdempotencyKey(input.idempotencyKey);

    return this.prisma.$transaction(async (tx) => {
      const invoiceLock = await this.lockInvoice(tx, input.purchaseInvoiceId);
      if (invoiceLock.status !== PurchaseInvoiceStatus.CONFIRMED) {
        throw new ConflictException(
          'Solo se puede recibir mercadería contra una factura de compra CONFIRMED',
        );
      }

      if (idempotencyKey !== null) {
        const existing = await tx.purchaseReceipt.findUnique({
          where: {
            purchaseInvoiceId_idempotencyKey: {
              purchaseInvoiceId: input.purchaseInvoiceId,
              idempotencyKey,
            },
          },
          select: PURCHASE_RECEIPT_SAFE_SELECT,
        });
        if (existing !== null) {
          // Reintento idempotente real: mismo resultado, sin duplicar
          // ningún efecto (stock/auditoría/contabilidad).
          return toSafePurchaseReceipt(existing);
        }
      }

      const lineIds = Array.from(requested.keys()).sort();
      const lockedLines = await tx.$queryRaw<LockedInvoiceLineRow[]>(Prisma.sql`
        SELECT id, purchase_invoice_id AS "purchaseInvoiceId",
               is_receipt_eligible AS "isReceiptEligible",
               quantity, product_id AS "productId",
               purchase_purpose AS "purchasePurpose",
               taxable_base_amount AS "taxableBaseAmount",
               tax_amount AS "taxAmount",
               creditable_tax_amount AS "creditableTaxAmount"
        FROM purchase_invoice_lines
        WHERE id = ANY(${lineIds}::uuid[])
        ORDER BY id ASC
        FOR UPDATE
      `);
      if (lockedLines.length !== lineIds.length) {
        throw new BadRequestException(
          'Alguna línea de factura referenciada no existe',
        );
      }
      for (const row of lockedLines) {
        if (row.purchaseInvoiceId !== input.purchaseInvoiceId) {
          throw new BadRequestException(
            'La línea referenciada no pertenece a la factura indicada',
          );
        }
        if (row.isReceiptEligible !== true) {
          throw new BadRequestException(
            'La línea no es elegible para recepción física (servicio, bien no inventariable, u otro concepto)',
          );
        }
      }

      const alreadyReceived = await tx.purchaseReceiptLine.groupBy({
        by: ['purchaseInvoiceLineId'],
        where: {
          purchaseInvoiceLineId: { in: lineIds },
          purchaseReceipt: { status: 'ACTIVE' },
        },
        _sum: { quantity: true },
      });
      const alreadyReceivedMap = new Map(
        alreadyReceived.map((r) => [
          r.purchaseInvoiceLineId,
          r._sum.quantity ?? ZERO,
        ]),
      );

      for (const row of lockedLines) {
        const requestedQty = requested.get(row.id);
        if (requestedQty === undefined) {
          throw new InternalServerErrorException(
            'Línea bloqueada sin cantidad solicitada; invariante interno roto',
          );
        }
        const prior = alreadyReceivedMap.get(row.id) ?? ZERO;
        if (prior.plus(requestedQty).greaterThan(row.quantity)) {
          throw new ConflictException(
            `La cantidad recibida excede lo facturado para la línea ${row.id}`,
          );
        }
      }

      const reclassificationPlan = await this.resolveReclassificationPlan(
        tx,
        lockedLines,
        requested,
        invoiceLock,
        alreadyReceivedMap,
      );

      const created = await tx.purchaseReceipt.create({
        data: {
          purchaseInvoiceId: input.purchaseInvoiceId,
          receivedDate,
          idempotencyKey,
          notes,
          createdByUserId: input.actorUserId,
          lines: {
            create: lockedLines.map((row) => {
              const qty = requested.get(row.id);
              if (qty === undefined) {
                throw new InternalServerErrorException(
                  'Línea bloqueada sin cantidad solicitada; invariante interno roto',
                );
              }
              return { purchaseInvoiceLineId: row.id, quantity: qty };
            }),
          },
        },
        select: PURCHASE_RECEIPT_SAFE_SELECT,
      });
      const createdLineIdByInvoiceLineId = new Map(
        created.lines.map((l) => [l.purchaseInvoiceLineId, l.id]),
      );

      // Capa física: SIEMPRE, sin importar el resultado contable — la
      // elegibilidad congelada (isReceiptEligible=true) ya garantiza
      // productId no nulo.
      for (const row of lockedLines) {
        const qty = requested.get(row.id);
        if (qty === undefined || row.productId === null) {
          throw new InternalServerErrorException(
            'Línea elegible sin productId; invariante interno roto',
          );
        }
        const movement = await this.stockMovementEngine.apply(tx, {
          productId: row.productId,
          quantity: qty,
          movementType: InventoryMovementType.ENTRY,
          origin: InventoryMovementOrigin.PURCHASE_RECEIPT,
          reason: 'Entrada por recepción de compra',
          notes: null,
          actorUserId: input.actorUserId,
          ipAddress: input.ipAddress,
          referenceType: PURCHASE_RECEIPT_REFERENCE_TYPE,
          referenceId: created.id,
        });

        // Capa de valorización OPCIONAL (Fase A6.1): no-op silencioso si
        // el producto no tiene valuationMethod configurado — cero
        // cambio de comportamiento del inventario físico. Misma
        // transacción `tx` que el movimiento físico: si falla, nada se
        // confirma (atomicidad).
        const receiptLineId = createdLineIdByInvoiceLineId.get(row.id);
        if (receiptLineId === undefined) {
          throw new InternalServerErrorException(
            'No se encontró la línea de recepción recién creada; invariante interno roto',
          );
        }
        await this.inventoryValuationEngine.recordOriginal(tx, {
          productId: row.productId,
          inventoryMovementId: movement.id,
          purchaseReceiptLineId: receiptLineId,
          purchaseInvoiceLineId: row.id,
          quantity: qty,
          invoicedQuantity: row.quantity,
          priorReceivedQuantity: alreadyReceivedMap.get(row.id) ?? ZERO,
          lineFinancials: {
            taxableBaseAmount: row.taxableBaseAmount,
            taxAmount: row.taxAmount,
            creditableTaxAmount: row.creditableTaxAmount,
          },
          actorUserId: input.actorUserId,
          ipAddress: input.ipAddress,
        });
      }

      // Capa contable OPCIONAL: solo si al menos una línea requiere
      // reclasificación (cuenta destino configurada como tránsito). El
      // caso predeterminado y seguro (sin ninguna cuenta configurada así)
      // nunca llama a AccountingEngine — cero efecto contable.
      let reclassificationEntryId: string | null = null;
      if (reclassificationPlan.length > 0) {
        const documentLabel = this.formatDocumentLabel(
          invoiceLock.documentType,
          invoiceLock.documentSeries,
          invoiceLock.documentNumber,
        );
        const resolvedLines =
          this.buildNettedReclassificationLines(reclassificationPlan);
        const posted =
          await this.accountingEngine.postPurchaseReceiptReclassification(tx, {
            purchaseReceiptId: created.id,
            description:
              buildPurchaseReceiptReclassificationDescription(documentLabel),
            accountingDateOnly: receivedDateString,
            lines: resolvedLines,
            actorUserId: input.actorUserId,
            ipAddress: input.ipAddress,
          });
        reclassificationEntryId = posted.id;
        for (const plan of reclassificationPlan) {
          const receiptLineId = createdLineIdByInvoiceLineId.get(plan.lineId);
          if (receiptLineId === undefined) {
            throw new InternalServerErrorException(
              'No se encontró la línea de recepción recién creada; invariante interno roto',
            );
          }
          await tx.purchaseReceiptLine.update({
            where: { id: receiptLineId },
            data: { reclassifiedAmount: plan.amount },
          });
        }
        await tx.purchaseReceipt.update({
          where: { id: created.id },
          data: { reclassificationEntryId },
        });
      }

      const finalRow = await tx.purchaseReceipt.findUniqueOrThrow({
        where: { id: created.id },
        select: PURCHASE_RECEIPT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PURCHASE_RECEIPTS',
        action: AuditAction.PURCHASE_RECEIPT_CREATED,
        entityType: 'PurchaseReceipt',
        entityId: created.id,
        description: `Recepción de compra ${created.id} registrada`,
        metadata: {
          purchaseInvoiceId: input.purchaseInvoiceId,
          lineCount: lockedLines.length,
          reclassified: reclassificationEntryId !== null,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafePurchaseReceipt(finalRow);
    });
  }

  // ==================================================================
  // Anulación
  // ==================================================================

  /**
   * Genera movimientos EXIT compensatorios (nunca elimina/edita los
   * ENTRY originales) y, si la recepción disparó una reclasificación
   * contable, la revierte exactamente vía AccountingEngine
   * (reverseOriginalForSource, sourceType=PURCHASE_RECEIPT) — nunca toca
   * el asiento PURCHASE original de la factura.
   */
  async cancel(
    input: CancelPurchaseReceiptInput,
  ): Promise<SafePurchaseReceipt> {
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
      const rows = await tx.$queryRaw<
        {
          id: string;
          status: string;
          purchaseInvoiceId: string;
          reclassificationEntryId: string | null;
        }[]
      >(Prisma.sql`
        SELECT id, status, purchase_invoice_id AS "purchaseInvoiceId",
               reclassification_entry_id AS "reclassificationEntryId"
        FROM purchase_receipts
        WHERE id = ${input.purchaseReceiptId}::uuid
        FOR UPDATE
      `);
      const locked = rows[0];
      if (locked === undefined) {
        throw new NotFoundException('Recepción de compra no encontrada');
      }
      if (locked.status !== 'ACTIVE') {
        throw new ConflictException(
          'Solo se puede anular una recepción en estado ACTIVE',
        );
      }

      const lines = await tx.purchaseReceiptLine.findMany({
        where: { purchaseReceiptId: locked.id },
        select: {
          id: true,
          purchaseInvoiceLine: { select: { productId: true } },
          quantity: true,
        },
      });

      for (const line of lines) {
        const productId = line.purchaseInvoiceLine.productId;
        if (productId === null) {
          throw new InternalServerErrorException(
            'Línea de recepción sin productId; invariante interno roto',
          );
        }
        const movement = await this.stockMovementEngine.apply(tx, {
          productId,
          quantity: line.quantity,
          movementType: InventoryMovementType.EXIT,
          origin: InventoryMovementOrigin.PURCHASE_RECEIPT_CANCELLATION,
          reason: 'Salida por anulación de recepción de compra',
          notes: null,
          actorUserId: input.actorUserId,
          ipAddress: input.ipAddress,
          referenceType: PURCHASE_RECEIPT_REFERENCE_TYPE,
          referenceId: locked.id,
        });

        // Capa de valorización OPCIONAL (Fase A6.1): no-op silencioso si
        // esta línea nunca se valorizó al recibirse (producto sin
        // valuationMethod en ese instante, o sin monto elegible). Nunca
        // recalcula el costo: reutiliza exactamente el del ORIGINAL.
        await this.inventoryValuationEngine.reverseForReceiptLine(tx, {
          purchaseReceiptLineId: line.id,
          newInventoryMovementId: movement.id,
          actorUserId: input.actorUserId,
          ipAddress: input.ipAddress,
        });
      }

      let reversalEntryId: string | null = null;
      if (locked.reclassificationEntryId !== null) {
        const reversal = await this.accountingEngine.reverseOriginalForSource(
          tx,
          {
            sourceType: AccountingSourceType.PURCHASE_RECEIPT,
            sourceId: locked.id,
            sourceNumber: locked.id,
            postedAt: new Date(),
            actorUserId: input.actorUserId,
            ipAddress: input.ipAddress,
          },
        );
        reversalEntryId = reversal.id;
      }

      const updated = await tx.purchaseReceipt.update({
        where: { id: locked.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledByUserId: input.actorUserId,
          cancellationReason: reason,
        },
        select: PURCHASE_RECEIPT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PURCHASE_RECEIPTS',
        action: AuditAction.PURCHASE_RECEIPT_CANCELLED,
        entityType: 'PurchaseReceipt',
        entityId: locked.id,
        description: `Recepción de compra ${locked.id} anulada`,
        metadata: { reason, reversalEntryId },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafePurchaseReceipt(updated);
    });
  }

  // ==================================================================
  // Helpers privados
  // ==================================================================

  private async lockInvoice(
    tx: Prisma.TransactionClient,
    purchaseInvoiceId: string,
  ): Promise<LockedPurchaseInvoiceRow> {
    const rows = await tx.$queryRaw<LockedPurchaseInvoiceRow[]>(Prisma.sql`
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

  private normalizeRequestedLines(
    lines: CreatePurchaseReceiptLineInput[],
  ): Map<string, Prisma.Decimal> {
    const requested = new Map<string, Prisma.Decimal>();
    for (const line of lines) {
      if (requested.has(line.purchaseInvoiceLineId)) {
        throw new BadRequestException(
          'No se puede referenciar la misma línea de factura dos veces en una recepción',
        );
      }
      let qty: Prisma.Decimal;
      try {
        qty = new Prisma.Decimal(line.quantity);
      } catch {
        throw new BadRequestException('quantity no es un decimal válido');
      }
      if (
        !qty.isFinite() ||
        qty.lessThanOrEqualTo(0) ||
        qty.decimalPlaces() > 3
      ) {
        throw new BadRequestException(
          'quantity debe ser un decimal positivo con máximo 3 decimales',
        );
      }
      requested.set(line.purchaseInvoiceLineId, qty);
    }
    return requested;
  }

  /**
   * Decide, cuenta por cuenta, si alguna línea recibida requiere
   * reclasificación contable. Nunca se infiere del nombre/código/systemKey
   * de la cuenta — exclusivamente de
   * Account.receiptReclassificationTargetAccountId, y solo tras verificar
   * que la cuenta de origen coincide con la que el asiento PURCHASE
   * original de la factura realmente debitó (si el mapeo cambió desde
   * entonces, se bloquea esa reclasificación puntual con 409, nunca se
   * reclasifica desde una cuenta distinta a la históricamente posteada).
   *
   * Asignación ACUMULADA (revisión previa al cierre, §1): el monto de
   * ESTA recepción nunca se calcula de forma aislada
   * (destinationAmount × cantidad_de_ESTA_recepción / facturado) — eso
   * puede dejar una diferencia de redondeo persistente tras varias
   * recepciones parciales. En su lugar: se calcula el monto objetivo
   * ACUMULADO hasta esta recepción inclusive
   * (destinationAmount × cantidad_acumulada / facturado, HALF_UP) y se
   * resta lo ya reclasificado en recepciones ACTIVE previas de la MISMA
   * línea — el residual exacto. Cuando esta recepción COMPLETA la línea
   * (cantidad acumulada >= facturado), el objetivo acumulado se fija en
   * destinationAmount EXACTO (nunca recalculado por redondeo), así que la
   * suma de todas las recepciones de una línea coincide siempre, al
   * céntimo, con el importe originalmente sujeto a reclasificación —
   * sin importar cuántas recepciones parciales haya habido.
   */
  private async resolveReclassificationPlan(
    tx: Prisma.TransactionClient,
    lockedLines: LockedInvoiceLineRow[],
    requested: Map<string, Prisma.Decimal>,
    invoiceLock: LockedPurchaseInvoiceRow,
    alreadyReceivedMap: Map<string, Prisma.Decimal>,
  ): Promise<ReclassificationPlanItem[]> {
    const purposesInvolved = Array.from(
      new Set(lockedLines.map((row) => row.purchasePurpose)),
    );
    if (purposesInvolved.length === 0) {
      return [];
    }
    const systemKeysInvolved = purposesInvolved.map(
      (purpose) => PURCHASE_PURPOSE_TO_SYSTEM_KEY[purpose],
    );
    const accounts = await tx.account.findMany({
      where: { systemKey: { in: systemKeysInvolved } },
    });
    const accountBySystemKey = new Map(
      accounts
        .filter((a) => a.systemKey !== null)
        .map((a) => [a.systemKey as AccountingSystemKey, a]),
    );

    let originalDebitAccountIds: Set<string> | null = null;
    const plan: ReclassificationPlanItem[] = [];

    for (const row of lockedLines) {
      const systemKey = PURCHASE_PURPOSE_TO_SYSTEM_KEY[row.purchasePurpose];
      const sourceAccount = accountBySystemKey.get(systemKey);
      if (sourceAccount === undefined) {
        // Sin ninguna cuenta mapeada a este systemKey: nada que
        // reclasificar (y la factura nunca habría podido confirmarse si
        // esto fuera el ÚNICO mapeo requerido — pero puede haberse
        // reasignado a null después de confirmar; eso es un problema de
        // reportería histórica, no de esta reclasificación opcional).
        continue;
      }
      if (sourceAccount.receiptReclassificationTargetAccountId === null) {
        // Caso predeterminado y seguro: esta cuenta ya es el destino
        // final, nunca se genera una reclasificación artificial.
        continue;
      }

      if (originalDebitAccountIds === null) {
        const originalLines =
          invoiceLock.postedEntryId !== null
            ? await tx.accountingEntryLine.findMany({
                where: {
                  entryId: invoiceLock.postedEntryId,
                  debitAmount: { gt: 0 },
                },
                select: { accountId: true },
              })
            : [];
        originalDebitAccountIds = new Set(
          originalLines.map((l) => l.accountId),
        );
      }
      if (!originalDebitAccountIds.has(sourceAccount.id)) {
        throw new ConflictException(
          `No se puede determinar con seguridad la cuenta de origen para reclasificar la línea ${row.id}: el mapeo contable cambió desde que la factura se confirmó`,
        );
      }

      const targetAccount = await tx.account.findUnique({
        where: { id: sourceAccount.receiptReclassificationTargetAccountId },
      });
      if (
        targetAccount === null ||
        targetAccount.status !== AccountStatus.ACTIVE ||
        !targetAccount.isPostable
      ) {
        throw new ConflictException(
          `La cuenta de reclasificación configurada para "${sourceAccount.code}" no existe o no está activa/postable`,
        );
      }
      if (targetAccount.receiptReclassificationTargetAccountId !== null) {
        throw new InternalServerErrorException(
          'Cadena de reclasificación inválida: la cuenta destino también tiene su propia cuenta de reclasificación configurada',
        );
      }

      const requestedQty = requested.get(row.id);
      if (requestedQty === undefined) {
        throw new InternalServerErrorException(
          'Línea bloqueada sin cantidad solicitada; invariante interno roto',
        );
      }

      // Historial de reclasificación de ESTA MISMA línea (recepciones
      // ACTIVE previas) — necesario para el ajuste acumulado de arriba.
      const priorReceiptLines = await tx.purchaseReceiptLine.findMany({
        where: {
          purchaseInvoiceLineId: row.id,
          purchaseReceipt: { status: 'ACTIVE' },
        },
        select: { reclassifiedAmount: true },
      });
      // Si esta línea tuvo recepciones previas que NUNCA pasaron por
      // reclasificación (NULL) mientras que AHORA sí requiere — la
      // política cambió entre recepciones de la MISMA línea; no es seguro
      // asumir que el residual "atrapa" esas recepciones anteriores, así
      // que se bloquea en vez de inventar un criterio de retroactividad.
      if (
        priorReceiptLines.length > 0 &&
        priorReceiptLines.some((l) => l.reclassifiedAmount === null)
      ) {
        throw new ConflictException(
          `No se puede determinar con seguridad la reclasificación de la línea ${row.id}: recepciones previas de esta misma línea no se reclasificaron de forma consistente`,
        );
      }
      const alreadyReclassified = priorReceiptLines.reduce(
        (sum, l) => sum.plus(l.reclassifiedAmount ?? ZERO),
        ZERO,
      );

      const destinationAmount = computeLineDestinationAmount(row);
      const priorReceivedQty = alreadyReceivedMap.get(row.id) ?? ZERO;
      const cumulativeReceivedQty = priorReceivedQty.plus(requestedQty);
      const isCompleting = cumulativeReceivedQty.greaterThanOrEqualTo(
        row.quantity,
      );
      const targetCumulativeAmount = isCompleting
        ? destinationAmount
        : computeProportionalReclassificationAmount(
            destinationAmount,
            cumulativeReceivedQty,
            row.quantity,
          );
      const residual = targetCumulativeAmount.minus(alreadyReclassified);
      // Defensa en profundidad: con aritmética Decimal exacta y el ajuste
      // exacto en la recepción que completa, `residual` nunca debería ser
      // negativo; si lo fuera (invariante roto en otra parte), se trata
      // como "nada que reclasificar" en vez de postear un monto inválido
      // (el CHECK reclassified_amount > 0 lo rechazaría de todos modos).
      const amount = residual.greaterThan(0) ? residual : ZERO;
      if (amount.greaterThan(0)) {
        plan.push({
          lineId: row.id,
          sourceAccountId: sourceAccount.id,
          targetAccountId: targetAccount.id,
          amount,
        });
      }
    }

    return plan;
  }

  /**
   * Agrega por cuenta y NETEA débito contra crédito cuando una misma
   * cuenta aparece como origen de un propósito y destino de otro dentro
   * de la MISMA recepción — una línea de AccountingEntryLine nunca tiene
   * ambos lados positivos (CHECK existente, Fase 8).
   */
  private buildNettedReclassificationLines(plan: ReclassificationPlanItem[]): {
    accountId: string;
    debitAmount: Prisma.Decimal;
    creditAmount: Prisma.Decimal;
  }[] {
    const debitTotals = new Map<string, Prisma.Decimal>();
    const creditTotals = new Map<string, Prisma.Decimal>();
    for (const item of plan) {
      debitTotals.set(
        item.targetAccountId,
        (debitTotals.get(item.targetAccountId) ?? ZERO).plus(item.amount),
      );
      creditTotals.set(
        item.sourceAccountId,
        (creditTotals.get(item.sourceAccountId) ?? ZERO).plus(item.amount),
      );
    }
    const accountIds = new Set([...debitTotals.keys(), ...creditTotals.keys()]);
    const lines: {
      accountId: string;
      debitAmount: Prisma.Decimal;
      creditAmount: Prisma.Decimal;
    }[] = [];
    for (const accountId of accountIds) {
      const debit = debitTotals.get(accountId) ?? ZERO;
      const credit = creditTotals.get(accountId) ?? ZERO;
      const net = debit.minus(credit);
      if (net.greaterThan(0)) {
        lines.push({ accountId, debitAmount: net, creditAmount: ZERO });
      } else if (net.lessThan(0)) {
        lines.push({ accountId, debitAmount: ZERO, creditAmount: net.abs() });
      }
    }
    return lines;
  }

  private normalizeDateOnly(raw: string, fieldName: string): Date {
    if (!isValidDateOnly(raw)) {
      throw new BadRequestException(
        `${fieldName} debe ser una fecha real en formato YYYY-MM-DD`,
      );
    }
    return toPrismaDate(raw);
  }

  private normalizeNotes(raw: string | undefined): string | null {
    if (raw === undefined) {
      return null;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private normalizeIdempotencyKey(raw: string | undefined): string | null {
    if (raw === undefined) {
      return null;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException(
        'idempotencyKey no puede estar en blanco si se provee',
      );
    }
    return trimmed;
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

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PurchaseReceiptStatus, RoleName } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { SettingsReader } from '../configuration/settings-reader.service';
import { PrismaService } from '../database/prisma.service';
import { computeProportionalAllocation } from './import-expense-allocation-calculator';
import {
  IMPORT_RECEIPT_LINK_SAFE_SELECT,
  toSafeImportReceiptLink,
} from './mappers/import-receipt-link.mapper';
import {
  CancelImportReceiptLinkInput,
  CreateImportReceiptLinkInput,
} from './types/create-import-receipt-link.input';
import { CostAttributionPreview } from './types/cost-attribution-preview';
import {
  LockedReceiptLineForLinkRow,
  LockedShipmentLineForLinkRow,
} from './types/locked-shipment-line-for-link.row';
import {
  SafeImportReceiptLink,
  SafeShipmentLineReceptionSummary,
  ShipmentLineReceptionStatus,
} from './types/safe-import-receipt-link';

const ZERO = new Prisma.Decimal(0);
const QUANTITY_PATTERN = /^\d{1,11}(\.\d{1,3})?$/;

const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
]);

function assertCanRead(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar vínculos de recepción de importación',
    );
  }
}

/**
 * Vínculo operativo entre el cargamento embarcado (Fase B1) y la
 * mercadería físicamente recibida (PurchaseReceipt, Fase A5.2b) —
 * CLAUDE.md B3 §1: "A link does NOT generate a second inventory entry".
 * NUNCA llama a StockMovementEngine/InventoryValuationEngine/
 * AccountingEngine: el único efecto es la fila de ImportReceiptLink
 * misma. La previsualización de atribución de costo (§3/§4) es PURA —
 * nunca persiste ni aplica nada financiero.
 */
@Injectable()
export class ImportReceiptLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly settingsReader: SettingsReader,
  ) {}

  async create(
    input: CreateImportReceiptLinkInput,
  ): Promise<SafeImportReceiptLink> {
    const linkedQuantity = parsePositiveQuantity(
      input.linkedQuantity,
      'linkedQuantity',
    );
    const idempotencyKey = normalizeOptionalText(input.idempotencyKey, 100);

    return this.prisma.$transaction(async (tx) => {
      // Orden de lock FIJO (nunca por valor de id): siempre la línea de
      // embarque primero, luego la línea de recepción — evita deadlocks
      // entre operaciones concurrentes de vinculación.
      const shipmentLine = await this.lockShipmentLine(
        tx,
        input.importShipmentLineId,
      );
      const receiptLine = await this.lockReceiptLine(
        tx,
        input.purchaseReceiptLineId,
      );

      if (shipmentLine.shipmentStatus !== 'ARRIVED') {
        throw new ConflictException(
          'El embarque debe estar ARRIVED para poder vincularse a una recepción física',
        );
      }
      if (receiptLine.receiptStatus !== PurchaseReceiptStatus.ACTIVE) {
        throw new ConflictException(
          'Solo se puede vincular contra una recepción de compra ACTIVE',
        );
      }
      if (
        shipmentLine.purchaseInvoiceLineId !== null &&
        shipmentLine.purchaseInvoiceLineId !== receiptLine.purchaseInvoiceLineId
      ) {
        throw new BadRequestException(
          'La línea de embarque referencia una factura de compra distinta a la de la recepción indicada',
        );
      }
      if (
        shipmentLine.productId !== null &&
        receiptLine.productId !== null &&
        shipmentLine.productId !== receiptLine.productId
      ) {
        throw new BadRequestException(
          'El producto de la línea de embarque no coincide con el de la recepción indicada',
        );
      }

      if (idempotencyKey !== null) {
        const existing = await tx.importReceiptLink.findUnique({
          where: {
            importShipmentLineId_idempotencyKey: {
              importShipmentLineId: input.importShipmentLineId,
              idempotencyKey,
            },
          },
          select: IMPORT_RECEIPT_LINK_SAFE_SELECT,
        });
        if (existing !== null) {
          return toSafeImportReceiptLink(existing);
        }
      }

      const duplicateActive = await tx.importReceiptLink.findFirst({
        where: {
          importShipmentLineId: input.importShipmentLineId,
          purchaseReceiptLineId: input.purchaseReceiptLineId,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      if (duplicateActive !== null) {
        throw new ConflictException(
          'Ya existe un vínculo ACTIVO entre esta línea de embarque y esta línea de recepción',
        );
      }

      const linkedToShipmentLine = await this.sumActiveLinkedQuantity(tx, {
        importShipmentLineId: input.importShipmentLineId,
      });
      if (
        linkedToShipmentLine
          .plus(linkedQuantity)
          .greaterThan(shipmentLine.plannedQuantity)
      ) {
        throw new ConflictException(
          'La cantidad vinculada excede la cantidad embarcada de esta línea',
        );
      }

      const linkedToReceiptLine = await this.sumActiveLinkedQuantity(tx, {
        purchaseReceiptLineId: input.purchaseReceiptLineId,
      });
      if (
        linkedToReceiptLine
          .plus(linkedQuantity)
          .greaterThan(receiptLine.quantity)
      ) {
        throw new ConflictException(
          'La cantidad vinculada excede la cantidad físicamente recibida en esta línea',
        );
      }

      const created = await tx.importReceiptLink.create({
        data: {
          importShipmentLineId: input.importShipmentLineId,
          purchaseReceiptLineId: input.purchaseReceiptLineId,
          linkedQuantity,
          idempotencyKey,
          createdByUserId: input.actorUserId,
        },
        select: IMPORT_RECEIPT_LINK_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_RECEIPT_LINK_CREATED,
        entityType: 'ImportReceiptLink',
        entityId: created.id,
        description: `Vínculo de recepción ${created.id} creado`,
        metadata: {
          importShipmentLineId: input.importShipmentLineId,
          purchaseReceiptLineId: input.purchaseReceiptLineId,
          importReceiptLinkId: created.id,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportReceiptLink(created);
    });
  }

  async listByShipmentLine(
    importShipmentLineId: string,
    requesterRole: RoleName,
  ): Promise<SafeShipmentLineReceptionSummary> {
    assertCanRead(requesterRole);

    const line = await this.prisma.importShipmentLine.findUnique({
      where: { id: importShipmentLineId },
      select: { id: true, plannedQuantity: true },
    });
    if (line === null) {
      throw new NotFoundException('Línea de embarque no encontrada');
    }

    const rows = await this.prisma.importReceiptLink.findMany({
      where: { importShipmentLineId },
      select: IMPORT_RECEIPT_LINK_SAFE_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const linkedReceivedQuantity = rows
      .filter((r) => r.status === 'ACTIVE')
      .reduce((sum, r) => sum.plus(r.linkedQuantity), ZERO);
    const remainingQuantity = line.plannedQuantity.minus(
      linkedReceivedQuantity,
    );
    const receptionStatus: ShipmentLineReceptionStatus =
      linkedReceivedQuantity.lessThanOrEqualTo(0)
        ? 'PENDING'
        : linkedReceivedQuantity.greaterThanOrEqualTo(line.plannedQuantity)
          ? 'FULLY_RECEIVED'
          : 'PARTIALLY_RECEIVED';

    return {
      importShipmentLineId,
      shippedQuantity: line.plannedQuantity.toFixed(3),
      linkedReceivedQuantity: linkedReceivedQuantity.toFixed(3),
      remainingQuantity: (remainingQuantity.lessThan(0)
        ? ZERO
        : remainingQuantity
      ).toFixed(3),
      receptionStatus,
      links: rows.map(toSafeImportReceiptLink),
    };
  }

  /** ACTIVE -> CANCELLED. Única vía de invalidación de un vínculo — nunca eliminado físicamente. */
  async cancel(
    input: CancelImportReceiptLinkInput,
  ): Promise<SafeImportReceiptLink> {
    const reason = normalizeRequiredText(input.reason, 'reason', 300);

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; status: string }[]>(
        Prisma.sql`
          SELECT id, status
          FROM import_receipt_links
          WHERE id = ${input.importReceiptLinkId}::uuid
          FOR UPDATE
        `,
      );
      const locked = rows[0];
      if (locked === undefined) {
        throw new NotFoundException('Vínculo de recepción no encontrado');
      }
      if (locked.status !== 'ACTIVE') {
        throw new ConflictException('Solo se puede cancelar un vínculo ACTIVE');
      }

      const updated = await tx.importReceiptLink.update({
        where: { id: input.importReceiptLinkId },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledByUserId: input.actorUserId,
          cancellationReason: reason,
        },
        select: IMPORT_RECEIPT_LINK_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_RECEIPT_LINK_CANCELLED,
        entityType: 'ImportReceiptLink',
        entityId: input.importReceiptLinkId,
        description: `Vínculo de recepción ${input.importReceiptLinkId} cancelado`,
        metadata: { importReceiptLinkId: input.importReceiptLinkId },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportReceiptLink(updated);
    });
  }

  /**
   * Previsualización PURA (Fase B3, CLAUDE.md B3 §3/§4) de cómo se
   * repartiría el monto YA asignado por B2 (concepto B: asignación
   * operativa) entre las recepciones físicas reales vinculadas — NUNCA
   * constituye el concepto C (monto aprobado para capitalización).
   * Reutiliza la MISMA función de reparto proporcional exacto que B2
   * (`computeProportionalAllocation`), nunca una segunda implementación.
   * Nunca persiste, nunca audita, nunca aplica nada financiero.
   */
  async previewCostAttribution(
    importExpenseAllocationId: string,
    requesterRole: RoleName,
  ): Promise<CostAttributionPreview> {
    assertCanRead(requesterRole);

    const allocation = await this.prisma.importExpenseAllocation.findUnique({
      where: { id: importExpenseAllocationId },
      select: {
        id: true,
        importShipmentLineId: true,
        amount: true,
        importShipmentLine: { select: { plannedQuantity: true } },
        batch: {
          select: {
            importExpense: { select: { currencyCode: true } },
          },
        },
      },
    });
    if (allocation === null) {
      throw new NotFoundException(
        'Línea de asignación de gasto de importación no encontrada',
      );
    }

    const activeLinks = await this.prisma.importReceiptLink.findMany({
      where: {
        importShipmentLineId: allocation.importShipmentLineId,
        status: 'ACTIVE',
      },
      select: { id: true, purchaseReceiptLineId: true, linkedQuantity: true },
      orderBy: { id: 'asc' },
    });

    // El monto asignado es proporcional a toda la cantidad EMBARCADA
    // (plannedQuantity), nunca solo a lo ya vinculado: repartir únicamente
    // entre los vínculos ACTIVE (base = su propia suma) sobreatribuía el
    // 100% del gasto a una recepción parcial. La porción correspondiente a
    // lo todavía SIN vincular se aísla con un objetivo virtual (nunca
    // expuesto en `lines`) que, al ir último, absorbe el residual exacto
    // de redondeo — cuando la cantidad recibida ya iguala lo embarcado, su
    // peso es 0 y el último vínculo ACTIVO real vuelve a absorber el
    // residual exacto, igual que antes (CLAUDE.md B3 §4: "amount
    // attributed never exceeds approved eligible amount").
    const plannedQuantity = allocation.importShipmentLine.plannedQuantity;
    const receivedQuantity = activeLinks.reduce(
      (sum, link) => sum.plus(link.linkedQuantity),
      ZERO,
    );
    const unreceivedQuantity = plannedQuantity.minus(receivedQuantity);

    const targets = activeLinks.map((link) => ({
      importShipmentLineId: link.id,
      weight: link.linkedQuantity,
    }));
    if (unreceivedQuantity.greaterThan(0)) {
      targets.push({
        importShipmentLineId: '__unattributed__',
        weight: unreceivedQuantity,
      });
    }

    const results =
      targets.length === 0
        ? []
        : computeProportionalAllocation(targets, allocation.amount);

    const lines = activeLinks.map((link, index) => ({
      purchaseReceiptLineId: link.purchaseReceiptLineId,
      importReceiptLinkId: link.id,
      receivedQuantity: link.linkedQuantity.toFixed(3),
      attributedAmount: results[index].amount.toFixed(2),
    }));
    const unattributedAmount = (
      unreceivedQuantity.greaterThan(0)
        ? results[results.length - 1].amount
        : ZERO
    ).toFixed(2);

    const currencyCode = allocation.batch.importExpense.currencyCode;
    const companySettings = await this.settingsReader.getCurrent();
    const financialStatus =
      currencyCode !== companySettings.currencyCode
        ? ('PENDING_FX' as const)
        : ('PENDING_ACCOUNTING_POLICY' as const);
    const financialStatusReason =
      financialStatus === 'PENDING_FX'
        ? `El gasto está en ${currencyCode}, distinto de la moneda de la empresa (${companySettings.currencyCode}). Requiere un proceso de tipo de cambio aprobado antes de poder aplicarse.`
        : 'No existe todavía una política contable de capitalización aprobada para costos de importación. Este monto queda pendiente de esa decisión.';

    return {
      importExpenseAllocationId: allocation.id,
      importShipmentLineId: allocation.importShipmentLineId,
      currencyCode,
      allocatedAmount: allocation.amount.toFixed(2),
      lines,
      unattributedAmount,
      financialStatus,
      financialStatusReason,
    };
  }

  // ==================================================================
  // Helpers privados
  // ==================================================================

  private async lockShipmentLine(
    tx: Prisma.TransactionClient,
    importShipmentLineId: string,
  ): Promise<LockedShipmentLineForLinkRow> {
    const rows = await tx.$queryRaw<LockedShipmentLineForLinkRow[]>(
      Prisma.sql`
        SELECT isl.id, isl.planned_quantity AS "plannedQuantity",
               isl.product_id AS "productId",
               isl.purchase_invoice_line_id AS "purchaseInvoiceLineId",
               ish.status AS "shipmentStatus"
        FROM import_shipment_lines isl
        JOIN import_shipments ish ON ish.id = isl.import_shipment_id
        WHERE isl.id = ${importShipmentLineId}::uuid
        FOR UPDATE OF isl
      `,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('Línea de embarque no encontrada');
    }
    return row;
  }

  private async lockReceiptLine(
    tx: Prisma.TransactionClient,
    purchaseReceiptLineId: string,
  ): Promise<LockedReceiptLineForLinkRow> {
    const rows = await tx.$queryRaw<LockedReceiptLineForLinkRow[]>(
      Prisma.sql`
        SELECT prl.id, prl.quantity,
               prl.purchase_invoice_line_id AS "purchaseInvoiceLineId",
               pil.product_id AS "productId",
               pr.status AS "receiptStatus"
        FROM purchase_receipt_lines prl
        JOIN purchase_receipts pr ON pr.id = prl.purchase_receipt_id
        JOIN purchase_invoice_lines pil ON pil.id = prl.purchase_invoice_line_id
        WHERE prl.id = ${purchaseReceiptLineId}::uuid
        FOR UPDATE OF prl
      `,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new BadRequestException(
        'Línea de recepción de compra no encontrada',
      );
    }
    return row;
  }

  private async sumActiveLinkedQuantity(
    tx: Prisma.TransactionClient,
    where: { importShipmentLineId?: string; purchaseReceiptLineId?: string },
  ): Promise<Prisma.Decimal> {
    const rows = await tx.importReceiptLink.findMany({
      where: { ...where, status: 'ACTIVE' },
      select: { linkedQuantity: true },
    });
    return rows.reduce((sum, r) => sum.plus(r.linkedQuantity), ZERO);
  }
}

function normalizeRequiredText(
  value: string,
  fieldName: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${fieldName} debe ser un texto`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BadRequestException(`${fieldName} no puede estar vacío`);
  }
  if (trimmed.length > maxLength) {
    throw new BadRequestException(
      `${fieldName} no puede superar los ${maxLength} caracteres`,
    );
  }
  return trimmed;
}

function normalizeOptionalText(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new BadRequestException(
      `El campo no puede superar los ${maxLength} caracteres`,
    );
  }
  return trimmed.length > 0 ? trimmed : null;
}

function parsePositiveQuantity(raw: string, fieldName: string): Prisma.Decimal {
  if (typeof raw !== 'string' || !QUANTITY_PATTERN.test(raw)) {
    throw new BadRequestException(
      `${fieldName} debe ser un decimal positivo, como texto, con máximo 3 decimales`,
    );
  }
  const value = new Prisma.Decimal(raw);
  if (value.lessThanOrEqualTo(0)) {
    throw new BadRequestException(`${fieldName} debe ser mayor que cero`);
  }
  return value;
}

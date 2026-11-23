import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ImportOperationStatus,
  ImportReceivingMode,
  ImportShipmentStatus,
  Prisma,
  PurchaseInvoiceStatus,
  PurchaseReceiptStatus,
  RoleName,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { businessToday } from '../common/date/business-date';
import {
  BusinessConflictException,
  FieldBadRequestException,
} from '../common/errors/error-contract';
import { PrismaService } from '../database/prisma.service';
import { PurchaseReceiptsService } from '../purchase-receipts/purchase-receipts.service';
import { SafePurchaseReceipt } from '../purchase-receipts/types/safe-purchase-receipt';
import {
  LinkExistingReceiptsDto,
  ReceiveFromImportDto,
} from './dto/import-receiving.dto';
import { ImportOperationsService } from './import-operations.service';
import { ImportReceiptLinksService } from './import-receipt-links.service';
import {
  IMPORT_RECEIPT_LINK_SAFE_SELECT,
  toSafeImportReceiptLink,
} from './mappers/import-receipt-link.mapper';
import {
  ImportReceivingCandidateReceiptLine,
  ImportReceivingLineSummary,
  ImportReceivingResult,
  ImportReceivingShipmentSummary,
  ImportReceivingSummary,
} from './types/import-receiving.types';

const ZERO = new Prisma.Decimal(0);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
/** La recepción + vínculos + cierre componen varias operaciones: más margen que los 5 s por defecto. */
const TRANSACTION_OPTIONS = { timeout: 30000, maxWait: 10000 } as const;

/**
 * Registrar recepción desde Importaciones exige a la vez operar la importación
 * (ADMIN/PURCHASING) y poder registrar recepciones de compra: se evalúan ambas
 * capas, nunca por el solo acceso a una pantalla.
 */
const WRITE_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.PURCHASING,
]);
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
  RoleName.PURCHASING,
]);

interface LockedOperationRow {
  id: string;
  status: ImportOperationStatus;
  purchaseInvoiceId: string | null;
}

interface LockedShipmentRow {
  id: string;
  importOperationId: string;
  status: ImportShipmentStatus;
}

interface ShipmentLineWithInvoiceRow {
  id: string;
  plannedQuantity: Prisma.Decimal;
  purchaseInvoiceLineId: string | null;
  isReceiptEligible: boolean | null;
  invoicedQuantity: Prisma.Decimal | null;
}

interface CommonInput {
  importOperationId: string;
  importShipmentId: string;
  idempotencyKey: string | undefined;
  actorUserId: string;
  requesterRole: RoleName;
  ipAddress: string | null;
}

export interface ReceiveFromImportInput extends CommonInput {
  body: ReceiveFromImportDto;
}

export interface LinkExistingReceiptsInput extends CommonInput {
  body: LinkExistingReceiptsDto;
}

function assertWrite(role: RoleName): void {
  if (!WRITE_ROLES.has(role)) {
    throw new ForbiddenException(
      'No tiene permisos para registrar recepciones desde importaciones',
    );
  }
}

function assertRead(role: RoleName): void {
  if (!READ_ROLES.has(role)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar la recepción de importaciones',
    );
  }
}

function toQty(value: Prisma.Decimal): string {
  return value.toFixed(3);
}

function nonNegative(value: Prisma.Decimal): Prisma.Decimal {
  return value.lessThan(0) ? ZERO : value;
}

/**
 * Coordinador de "Recibir mercadería desde Importaciones" (R5). NO tiene un
 * mecanismo de inventario propio: compone, dentro de UNA sola transacción, la
 * recepción de compra existente (PurchaseReceiptsService: movimientos de
 * stock, valorización y reclasificación según las reglas vigentes), el vínculo
 * embarque↔recepción (ImportReceiptLinksService) y, opcionalmente, el cierre de
 * la importación. Nunca confirma la factura, nunca duplica deuda ni asientos de
 * compra y nunca capitaliza gastos de importación.
 *
 * Orden de locks (consistente con R2/R4): operación → embarque → factura →
 * líneas de factura (por id) → líneas de embarque (por id) → [recepción:
 * ubicaciones → productos por productId → saldo] → líneas de recepción.
 */
@Injectable()
export class ImportReceivingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly receiptsService: PurchaseReceiptsService,
    private readonly linksService: ImportReceiptLinksService,
    private readonly operationsService: ImportOperationsService,
  ) {}

  // ==================================================================
  // Lectura: cantidades y pendientes
  // ==================================================================

  async getSummary(
    importOperationId: string,
    requesterRole: RoleName,
  ): Promise<ImportReceivingSummary> {
    assertRead(requesterRole);

    return this.prisma.$transaction(
      async (tx) => {
        const operation = await tx.importOperation.findUnique({
          where: { id: importOperationId },
          select: {
            id: true,
            reference: true,
            status: true,
            purchaseInvoiceId: true,
            isLegacyUnlinked: true,
            purchaseInvoice: { select: { status: true } },
          },
        });
        if (operation === null) {
          throw new NotFoundException('Operación de importación no encontrada');
        }

        const shipments = await tx.importShipment.findMany({
          where: {
            importOperationId,
            status: { not: ImportShipmentStatus.CANCELLED },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            status: true,
            lines: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: {
                id: true,
                productId: true,
                descriptionSnapshot: true,
                unitCode: true,
                plannedQuantity: true,
                purchaseInvoiceLineId: true,
                product: { select: { sku: true } },
              },
            },
          },
        });

        const shipmentLineIds = shipments.flatMap((s) =>
          s.lines.map((l) => l.id),
        );
        const invoiceLineIds = Array.from(
          new Set(
            shipments
              .flatMap((s) => s.lines)
              .map((l) => l.purchaseInvoiceLineId)
              .filter((id): id is string => id !== null),
          ),
        );

        const [
          invoiceLines,
          receivedSums,
          assignedSums,
          linkSums,
          receiptLines,
        ] = await Promise.all([
          tx.purchaseInvoiceLine.findMany({
            where: { id: { in: invoiceLineIds } },
            select: { id: true, quantity: true, isReceiptEligible: true },
          }),
          tx.purchaseReceiptLine.groupBy({
            by: ['purchaseInvoiceLineId'],
            where: {
              purchaseInvoiceLineId: { in: invoiceLineIds },
              purchaseReceipt: { status: PurchaseReceiptStatus.ACTIVE },
            },
            _sum: { quantity: true },
          }),
          tx.importShipmentLine.groupBy({
            by: ['purchaseInvoiceLineId'],
            where: {
              purchaseInvoiceLineId: { in: invoiceLineIds },
              importShipment: {
                status: { not: ImportShipmentStatus.CANCELLED },
              },
            },
            _sum: { plannedQuantity: true },
          }),
          tx.importReceiptLink.groupBy({
            by: ['importShipmentLineId'],
            where: {
              importShipmentLineId: { in: shipmentLineIds },
              status: 'ACTIVE',
            },
            _sum: { linkedQuantity: true },
          }),
          tx.purchaseReceiptLine.findMany({
            where: {
              purchaseInvoiceLineId: { in: invoiceLineIds },
              purchaseReceipt: { status: PurchaseReceiptStatus.ACTIVE },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              purchaseInvoiceLineId: true,
              quantity: true,
              purchaseReceipt: { select: { id: true, receivedDate: true } },
            },
          }),
        ]);

        const receiptLineLinkSums = await tx.importReceiptLink.groupBy({
          by: ['purchaseReceiptLineId'],
          where: {
            purchaseReceiptLineId: { in: receiptLines.map((r) => r.id) },
            status: 'ACTIVE',
          },
          _sum: { linkedQuantity: true },
        });

        const invoiceLineMap = new Map(invoiceLines.map((l) => [l.id, l]));
        const receivedMap = new Map(
          receivedSums.map((r) => [
            r.purchaseInvoiceLineId,
            r._sum.quantity ?? ZERO,
          ]),
        );
        const assignedMap = new Map(
          assignedSums.map((r) => [
            r.purchaseInvoiceLineId,
            r._sum.plannedQuantity ?? ZERO,
          ]),
        );
        const linkedMap = new Map(
          linkSums.map((r) => [
            r.importShipmentLineId,
            r._sum.linkedQuantity ?? ZERO,
          ]),
        );
        const receiptLinkedMap = new Map(
          receiptLineLinkSums.map((r) => [
            r.purchaseReceiptLineId,
            r._sum.linkedQuantity ?? ZERO,
          ]),
        );

        const operationBlock = this.operationBlockReason(
          operation.status,
          operation.purchaseInvoiceId,
          operation.purchaseInvoice?.status ?? null,
        );

        let pendingTotal = ZERO;
        const shipmentSummaries: ImportReceivingShipmentSummary[] =
          shipments.map((shipment) => {
            const lines: ImportReceivingLineSummary[] = shipment.lines.map(
              (line) => {
                const invoiceLine =
                  line.purchaseInvoiceLineId === null
                    ? undefined
                    : invoiceLineMap.get(line.purchaseInvoiceLineId);
                const isReceivable = invoiceLine?.isReceiptEligible === true;
                const linked = linkedMap.get(line.id) ?? ZERO;
                const pending = nonNegative(line.plannedQuantity.minus(linked));
                const received =
                  line.purchaseInvoiceLineId === null
                    ? null
                    : (receivedMap.get(line.purchaseInvoiceLineId) ?? ZERO);
                const invoicePending =
                  invoiceLine === undefined || received === null
                    ? null
                    : nonNegative(invoiceLine.quantity.minus(received));
                const maxNow =
                  isReceivable && invoicePending !== null
                    ? Prisma.Decimal.min(pending, invoicePending)
                    : ZERO;
                if (isReceivable) {
                  pendingTotal = pendingTotal.plus(pending);
                }
                const candidates: ImportReceivingCandidateReceiptLine[] =
                  line.purchaseInvoiceLineId === null
                    ? []
                    : receiptLines
                        .filter(
                          (r) =>
                            r.purchaseInvoiceLineId ===
                            line.purchaseInvoiceLineId,
                        )
                        .map((r) => {
                          const linkedElsewhere =
                            receiptLinkedMap.get(r.id) ?? ZERO;
                          return {
                            purchaseReceiptLineId: r.id,
                            purchaseReceiptId: r.purchaseReceipt.id,
                            receivedDate: r.purchaseReceipt.receivedDate
                              .toISOString()
                              .slice(0, 10),
                            receivedQuantity: toQty(r.quantity),
                            linkedElsewhereQuantity: toQty(linkedElsewhere),
                            availableToLinkQuantity: toQty(
                              nonNegative(r.quantity.minus(linkedElsewhere)),
                            ),
                          };
                        })
                        .filter((c) =>
                          new Prisma.Decimal(
                            c.availableToLinkQuantity,
                          ).greaterThan(0),
                        );
                return {
                  importShipmentLineId: line.id,
                  productId: line.productId,
                  sku: line.product?.sku ?? null,
                  description: line.descriptionSnapshot,
                  unitCode: line.unitCode,
                  purchaseInvoiceLineId: line.purchaseInvoiceLineId,
                  isReceivable,
                  invoicedQuantity: invoiceLine
                    ? toQty(invoiceLine.quantity)
                    : null,
                  assignedToShipmentsQuantity:
                    line.purchaseInvoiceLineId === null
                      ? null
                      : toQty(
                          assignedMap.get(line.purchaseInvoiceLineId) ?? ZERO,
                        ),
                  receivedQuantity: received === null ? null : toQty(received),
                  shipmentLineQuantity: toQty(line.plannedQuantity),
                  linkedQuantity: toQty(linked),
                  pendingQuantity: toQty(pending),
                  invoicePendingReceivableQuantity:
                    invoicePending === null ? null : toQty(invoicePending),
                  maxReceivableNow: toQty(maxNow),
                  candidateReceiptLines: isReceivable ? candidates : [],
                };
              },
            );
            return {
              importShipmentId: shipment.id,
              status: shipment.status,
              canReceive:
                operationBlock === null &&
                shipment.status === ImportShipmentStatus.ARRIVED,
              lines,
            };
          });

        const closeBlock = this.closeBlockReason(
          operation.status,
          shipments.map((s) => s.status),
          pendingTotal,
        );
        return {
          importOperationId: operation.id,
          reference: operation.reference,
          status: operation.status,
          purchaseInvoiceId: operation.purchaseInvoiceId,
          purchaseInvoiceStatus: operation.purchaseInvoice?.status ?? null,
          isLegacyUnlinked: operation.isLegacyUnlinked,
          canReceive: operationBlock === null,
          cannotReceiveReason: operationBlock,
          pendingQuantityTotal: toQty(pendingTotal),
          canComplete: closeBlock === null,
          cannotCompleteReason: closeBlock,
          shipments: shipmentSummaries,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  // ==================================================================
  // Recibir mercadería (crea la recepción de compra + vínculo)
  // ==================================================================

  async receive(input: ReceiveFromImportInput): Promise<ImportReceivingResult> {
    assertWrite(input.requesterRole);
    const idempotencyKey = this.requireIdempotencyKey(input.idempotencyKey);
    const { body } = input;

    const lineIds = body.lines.map((l) => l.importShipmentLineId);
    const duplicateIndex = lineIds.findIndex(
      (id, index) => lineIds.indexOf(id) !== index,
    );
    if (duplicateIndex !== -1) {
      throw new FieldBadRequestException({
        message: 'Una línea de embarque no puede repetirse en la solicitud',
        code: 'DUPLICATE_SHIPMENT_LINE',
        field: `lines[${duplicateIndex}].importShipmentLineId`,
        type: 'BUSINESS',
      });
    }
    const quantities = body.lines.map((l) => new Prisma.Decimal(l.quantity));
    const zeroIndex = quantities.findIndex((q) => q.lessThanOrEqualTo(0));
    if (zeroIndex !== -1) {
      throw new FieldBadRequestException({
        message: 'La cantidad recibida debe ser mayor que cero',
        code: 'QUANTITY_MUST_BE_POSITIVE',
        field: `lines[${zeroIndex}].quantity`,
        type: 'BUSINESS',
      });
    }
    const receivedDate = body.receivedDate ?? businessToday();

    const requestHash = this.hash({
      mode: 'RECEIVE',
      importShipmentId: input.importShipmentId,
      receivedDate: body.receivedDate ?? null,
      notes: body.notes?.trim() ?? null,
      completeOperation: body.completeOperation === true,
      lines: body.lines
        .map((l, i) => ({
          importShipmentLineId: l.importShipmentLineId,
          quantity: quantities[i].toFixed(3),
          locationId: l.locationId ?? null,
        }))
        .sort((a, b) =>
          a.importShipmentLineId.localeCompare(b.importShipmentLineId),
        ),
    });

    const outcome = await this.prisma.$transaction(async (tx) => {
      const prelude = await this.begin(tx, {
        input,
        idempotencyKey,
        requestHash,
        mode: ImportReceivingMode.RECEIVE,
        invoiceLock: 'UPDATE',
      });
      if (prelude.replayRequestId !== null) {
        return { requestId: prelude.replayRequestId, replay: true };
      }
      const { operation, request } = prelude;
      const invoiceId = operation.purchaseInvoiceId as string;

      // Líneas de embarque pedidas: existen, son de ESTE embarque.
      const rows = await tx.$queryRaw<ShipmentLineWithInvoiceRow[]>(Prisma.sql`
        SELECT isl.id,
               isl.planned_quantity AS "plannedQuantity",
               isl.purchase_invoice_line_id AS "purchaseInvoiceLineId",
               pil.is_receipt_eligible AS "isReceiptEligible",
               pil.quantity AS "invoicedQuantity"
        FROM import_shipment_lines isl
        LEFT JOIN purchase_invoice_lines pil
               ON pil.id = isl.purchase_invoice_line_id
        WHERE isl.id = ANY(${lineIds}::uuid[])
          AND isl.import_shipment_id = ${input.importShipmentId}::uuid
      `);
      const byId = new Map(rows.map((r) => [r.id, r]));
      body.lines.forEach((line, index) => {
        const row = byId.get(line.importShipmentLineId);
        if (row === undefined) {
          throw new FieldBadRequestException({
            message: 'La línea de embarque no pertenece a este embarque',
            code: 'SHIPMENT_LINE_NOT_IN_SHIPMENT',
            field: `lines[${index}].importShipmentLineId`,
            type: 'BUSINESS',
          });
        }
        if (
          row.purchaseInvoiceLineId === null ||
          row.isReceiptEligible !== true
        ) {
          throw new BusinessConflictException({
            message:
              'La línea no es recibible: no es un bien inventariable de la factura vinculada',
            code: 'SHIPMENT_LINE_NOT_RECEIVABLE',
            field: `lines[${index}].importShipmentLineId`,
            type: 'BUSINESS',
          });
        }
      });

      // Locks: líneas de factura (por id) y luego líneas de embarque (por id).
      const invoiceLineIds = Array.from(
        new Set(rows.map((r) => r.purchaseInvoiceLineId as string)),
      ).sort();
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM purchase_invoice_lines
        WHERE id = ANY(${invoiceLineIds}::uuid[])
        ORDER BY id ASC FOR UPDATE
      `);
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM import_shipment_lines
        WHERE id = ANY(${[...lineIds].sort()}::uuid[])
        ORDER BY id ASC FOR UPDATE
      `);

      const [linkSums, receivedSums] = await Promise.all([
        tx.importReceiptLink.groupBy({
          by: ['importShipmentLineId'],
          where: { importShipmentLineId: { in: lineIds }, status: 'ACTIVE' },
          _sum: { linkedQuantity: true },
        }),
        tx.purchaseReceiptLine.groupBy({
          by: ['purchaseInvoiceLineId'],
          where: {
            purchaseInvoiceLineId: { in: invoiceLineIds },
            purchaseReceipt: { status: PurchaseReceiptStatus.ACTIVE },
          },
          _sum: { quantity: true },
        }),
      ]);
      const linkedMap = new Map(
        linkSums.map((r) => [
          r.importShipmentLineId,
          r._sum.linkedQuantity ?? ZERO,
        ]),
      );
      const receivedMap = new Map(
        receivedSums.map((r) => [
          r.purchaseInvoiceLineId,
          r._sum.quantity ?? ZERO,
        ]),
      );

      // Pendiente de la línea de embarque y disponible de la factura.
      const requestedByInvoiceLine = new Map<string, Prisma.Decimal>();
      const locationByInvoiceLine = new Map<string, string | null>();
      body.lines.forEach((line, index) => {
        const row = byId.get(
          line.importShipmentLineId,
        ) as ShipmentLineWithInvoiceRow;
        const qty = quantities[index];
        const pending = row.plannedQuantity.minus(
          linkedMap.get(row.id) ?? ZERO,
        );
        if (qty.greaterThan(pending)) {
          throw new BusinessConflictException({
            message: `La cantidad supera lo pendiente de esta línea de embarque (${toQty(nonNegative(pending))})`,
            code: 'IMPORT_QUANTITY_EXCEEDS_PENDING',
            field: `lines[${index}].quantity`,
            type: 'BUSINESS',
          });
        }
        const invoiceLineId = row.purchaseInvoiceLineId as string;
        const location = line.locationId ?? null;
        if (
          locationByInvoiceLine.has(invoiceLineId) &&
          locationByInvoiceLine.get(invoiceLineId) !== location
        ) {
          throw new FieldBadRequestException({
            message:
              'Dos líneas de embarque de la misma línea de factura deben usar la misma ubicación',
            code: 'LOCATION_CONFLICT',
            field: `lines[${index}].locationId`,
            type: 'BUSINESS',
          });
        }
        locationByInvoiceLine.set(invoiceLineId, location);
        requestedByInvoiceLine.set(
          invoiceLineId,
          (requestedByInvoiceLine.get(invoiceLineId) ?? ZERO).plus(qty),
        );
      });
      body.lines.forEach((line, index) => {
        const row = byId.get(
          line.importShipmentLineId,
        ) as ShipmentLineWithInvoiceRow;
        const invoiceLineId = row.purchaseInvoiceLineId as string;
        const available = (row.invoicedQuantity as Prisma.Decimal).minus(
          receivedMap.get(invoiceLineId) ?? ZERO,
        );
        if (
          (
            requestedByInvoiceLine.get(invoiceLineId) as Prisma.Decimal
          ).greaterThan(available)
        ) {
          throw new BusinessConflictException({
            message: `La cantidad supera lo disponible de la factura (${toQty(nonNegative(available))}); considere las recepciones registradas desde Compras`,
            code: 'INVOICE_QUANTITY_EXCEEDED',
            field: `lines[${index}].quantity`,
            type: 'BUSINESS',
          });
        }
      });

      // Recepción de compra EXISTENTE (stock, valorización, reclasificación).
      const receipt: SafePurchaseReceipt =
        await this.receiptsService.createInTransaction(tx, {
          purchaseInvoiceId: invoiceId,
          receivedDate,
          notes: body.notes,
          lines: Array.from(requestedByInvoiceLine.entries()).map(
            ([purchaseInvoiceLineId, quantity]) => ({
              purchaseInvoiceLineId,
              quantity: quantity.toFixed(3),
              ...(locationByInvoiceLine.get(purchaseInvoiceLineId)
                ? {
                    locationId: locationByInvoiceLine.get(
                      purchaseInvoiceLineId,
                    ) as string,
                  }
                : {}),
            }),
          ),
          requesterRole: input.requesterRole,
          actorUserId: input.actorUserId,
          ipAddress: input.ipAddress,
        });
      const receiptLineByInvoiceLine = new Map(
        receipt.lines.map((l) => [l.purchaseInvoiceLineId, l.id]),
      );

      // Un vínculo por línea de embarque, en orden estable de id.
      const ordered = body.lines
        .map((line, index) => ({ line, qty: quantities[index] }))
        .sort((a, b) =>
          a.line.importShipmentLineId.localeCompare(
            b.line.importShipmentLineId,
          ),
        );
      for (const { line, qty } of ordered) {
        const row = byId.get(
          line.importShipmentLineId,
        ) as ShipmentLineWithInvoiceRow;
        const receiptLineId = receiptLineByInvoiceLine.get(
          row.purchaseInvoiceLineId as string,
        ) as string;
        await this.linksService.createInTransaction(tx, {
          importShipmentLineId: line.importShipmentLineId,
          purchaseReceiptLineId: receiptLineId,
          linkedQuantity: qty.toFixed(3),
          receivingRequestId: request.id,
          actorUserId: input.actorUserId,
          ipAddress: input.ipAddress,
        });
      }
      await tx.importReceivingRequest.update({
        where: { id: request.id },
        data: { purchaseReceiptId: receipt.id },
      });

      const completed = await this.maybeComplete(tx, input, request.id);
      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_RECEIVING_RECEIVED,
        entityType: 'ImportOperation',
        entityId: input.importOperationId,
        description: `Recepción ${receipt.id} registrada desde la importación`,
        metadata: {
          importOperationId: input.importOperationId,
          importShipmentId: input.importShipmentId,
          purchaseReceiptId: receipt.id,
          lineCount: body.lines.length,
          completedOperation: completed,
        },
        ipAddress: input.ipAddress,
        client: tx,
      });
      return { requestId: request.id, replay: false };
    }, TRANSACTION_OPTIONS);

    return this.buildResult(outcome.requestId, outcome.replay, input);
  }

  // ==================================================================
  // Vincular recepciones ya registradas (sin mover stock)
  // ==================================================================

  async linkExisting(
    input: LinkExistingReceiptsInput,
  ): Promise<ImportReceivingResult> {
    assertWrite(input.requesterRole);
    const idempotencyKey = this.requireIdempotencyKey(input.idempotencyKey);
    const { body } = input;

    const pairKeys = body.links.map(
      (l) => `${l.importShipmentLineId}|${l.purchaseReceiptLineId}`,
    );
    const duplicateIndex = pairKeys.findIndex(
      (key, index) => pairKeys.indexOf(key) !== index,
    );
    if (duplicateIndex !== -1) {
      throw new FieldBadRequestException({
        message: 'El mismo vínculo no puede repetirse en la solicitud',
        code: 'DUPLICATE_LINK',
        field: `links[${duplicateIndex}].purchaseReceiptLineId`,
        type: 'BUSINESS',
      });
    }
    const requestHash = this.hash({
      mode: 'LINK_EXISTING',
      importShipmentId: input.importShipmentId,
      completeOperation: body.completeOperation === true,
      links: body.links
        .map((l) => ({
          importShipmentLineId: l.importShipmentLineId,
          purchaseReceiptLineId: l.purchaseReceiptLineId,
          linkedQuantity: new Prisma.Decimal(l.linkedQuantity).toFixed(3),
        }))
        .sort((a, b) =>
          `${a.importShipmentLineId}${a.purchaseReceiptLineId}`.localeCompare(
            `${b.importShipmentLineId}${b.purchaseReceiptLineId}`,
          ),
        ),
    });

    const outcome = await this.prisma.$transaction(async (tx) => {
      const prelude = await this.begin(tx, {
        input,
        idempotencyKey,
        requestHash,
        mode: ImportReceivingMode.LINK_EXISTING,
        invoiceLock: 'SHARE',
      });
      if (prelude.replayRequestId !== null) {
        return { requestId: prelude.replayRequestId, replay: true };
      }
      const { request } = prelude;

      const shipmentLineIds = Array.from(
        new Set(body.links.map((l) => l.importShipmentLineId)),
      );
      const owned = await tx.importShipmentLine.findMany({
        where: {
          id: { in: shipmentLineIds },
          importShipmentId: input.importShipmentId,
        },
        select: { id: true },
      });
      const ownedIds = new Set(owned.map((l) => l.id));
      body.links.forEach((link, index) => {
        if (!ownedIds.has(link.importShipmentLineId)) {
          throw new FieldBadRequestException({
            message: 'La línea de embarque no pertenece a este embarque',
            code: 'SHIPMENT_LINE_NOT_IN_SHIPMENT',
            field: `links[${index}].importShipmentLineId`,
            type: 'BUSINESS',
          });
        }
      });

      const ordered = [...body.links].sort((a, b) =>
        `${a.importShipmentLineId}${a.purchaseReceiptLineId}`.localeCompare(
          `${b.importShipmentLineId}${b.purchaseReceiptLineId}`,
        ),
      );
      for (const link of ordered) {
        await this.linksService.createInTransaction(tx, {
          importShipmentLineId: link.importShipmentLineId,
          purchaseReceiptLineId: link.purchaseReceiptLineId,
          linkedQuantity: link.linkedQuantity,
          receivingRequestId: request.id,
          actorUserId: input.actorUserId,
          ipAddress: input.ipAddress,
        });
      }

      const completed = await this.maybeComplete(tx, input, request.id);
      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_RECEIVING_LINKED,
        entityType: 'ImportOperation',
        entityId: input.importOperationId,
        description:
          'Recepciones existentes vinculadas al embarque de la importación',
        metadata: {
          importOperationId: input.importOperationId,
          importShipmentId: input.importShipmentId,
          linkCount: body.links.length,
          completedOperation: completed,
        },
        ipAddress: input.ipAddress,
        client: tx,
      });
      return { requestId: request.id, replay: false };
    }, TRANSACTION_OPTIONS);

    return this.buildResult(outcome.requestId, outcome.replay, input);
  }

  // ==================================================================
  // Piezas comunes
  // ==================================================================

  /**
   * Bloqueos y validaciones previas comunes: operación (FOR UPDATE, serializa
   * solicitudes de la misma importación), idempotencia persistente, estado de
   * la operación, embarque ARRIVED y factura CONFIRMED. Crea la fila de
   * solicitud (clave única por operación) que respalda los vínculos.
   */
  private async begin(
    tx: Prisma.TransactionClient,
    params: {
      input: CommonInput;
      idempotencyKey: string;
      requestHash: string;
      mode: ImportReceivingMode;
      invoiceLock: 'UPDATE' | 'SHARE';
    },
  ): Promise<
    | { replayRequestId: string }
    | {
        replayRequestId: null;
        operation: LockedOperationRow;
        request: { id: string };
      }
  > {
    const { input } = params;
    const operations = await tx.$queryRaw<LockedOperationRow[]>(Prisma.sql`
      SELECT id, status, purchase_invoice_id AS "purchaseInvoiceId"
      FROM import_operations
      WHERE id = ${input.importOperationId}::uuid
      FOR UPDATE
    `);
    const operation = operations[0];
    if (operation === undefined) {
      throw new NotFoundException('Operación de importación no encontrada');
    }

    const existing = await tx.importReceivingRequest.findUnique({
      where: {
        importOperationId_idempotencyKey: {
          importOperationId: input.importOperationId,
          idempotencyKey: params.idempotencyKey,
        },
      },
      select: { id: true, requestHash: true },
    });
    if (existing !== null) {
      if (existing.requestHash !== params.requestHash) {
        throw new BusinessConflictException({
          message:
            'La Idempotency-Key ya se usó con una solicitud de contenido distinto',
          code: 'IDEMPOTENCY_KEY_CONFLICT',
        });
      }
      return { replayRequestId: existing.id };
    }

    if (operation.purchaseInvoiceId === null) {
      throw new BusinessConflictException({
        message:
          'La operación es histórica y no está vinculada a una factura de compra: no puede recibir mercadería desde Importaciones',
        code: 'IMPORT_NOT_LINKED_TO_INVOICE',
      });
    }
    if (operation.status !== ImportOperationStatus.IN_PROGRESS) {
      throw new BusinessConflictException({
        message:
          'Solo una operación de importación IN_PROGRESS puede recibir mercadería',
        code: 'IMPORT_OPERATION_NOT_ACTIVE',
      });
    }

    const shipments = await tx.$queryRaw<LockedShipmentRow[]>(Prisma.sql`
      SELECT id, import_operation_id AS "importOperationId", status
      FROM import_shipments
      WHERE id = ${input.importShipmentId}::uuid
      FOR UPDATE
    `);
    const shipment = shipments[0];
    if (
      shipment === undefined ||
      shipment.importOperationId !== input.importOperationId
    ) {
      throw new NotFoundException('Embarque de importación no encontrado');
    }
    if (shipment.status !== ImportShipmentStatus.ARRIVED) {
      throw new BusinessConflictException({
        message:
          'Solo se puede recibir mercadería de un embarque ARRIVED (llegado a destino)',
        code: 'SHIPMENT_NOT_ARRIVED',
      });
    }

    const invoices = await tx.$queryRaw<{ status: PurchaseInvoiceStatus }[]>(
      params.invoiceLock === 'UPDATE'
        ? Prisma.sql`SELECT status FROM purchase_invoices WHERE id = ${operation.purchaseInvoiceId}::uuid FOR UPDATE`
        : Prisma.sql`SELECT status FROM purchase_invoices WHERE id = ${operation.purchaseInvoiceId}::uuid FOR SHARE`,
    );
    if (invoices[0]?.status !== PurchaseInvoiceStatus.CONFIRMED) {
      throw new BusinessConflictException({
        message:
          'La factura de compra de la importación no está CONFIRMED: confírmela antes de recibir mercadería',
        code: 'PURCHASE_INVOICE_NOT_CONFIRMED',
      });
    }

    const request = await tx.importReceivingRequest.create({
      data: {
        importOperationId: input.importOperationId,
        idempotencyKey: params.idempotencyKey,
        requestHash: params.requestHash,
        mode: params.mode,
        createdByUserId: input.actorUserId,
      },
      select: { id: true },
    });
    return { replayRequestId: null, operation, request };
  }

  /**
   * "Recibir/vincular y completar": TODO o NADA. Tras aplicar la recepción o los
   * vínculos (ya visibles en esta transacción) exige que no quede cantidad
   * pendiente recibible y reutiliza el cierre existente (IN_PROGRESS y sin
   * embarques PLANNED/IN_TRANSIT). Cualquier incumplimiento revierte TODO.
   */
  private async maybeComplete(
    tx: Prisma.TransactionClient,
    input: CommonInput & { body: { completeOperation?: boolean } },
    requestId: string,
  ): Promise<boolean> {
    if (input.body.completeOperation !== true) {
      return false;
    }
    const pending = await tx.$queryRaw<
      { id: string; pending: Prisma.Decimal }[]
    >(Prisma.sql`
      SELECT isl.id,
             isl.planned_quantity - COALESCE(SUM(l.linked_quantity)
               FILTER (WHERE l.status = 'ACTIVE'), 0) AS pending
      FROM import_shipment_lines isl
      JOIN import_shipments ish
        ON ish.id = isl.import_shipment_id
       AND ish.import_operation_id = ${input.importOperationId}::uuid
       AND ish.status <> 'CANCELLED'
      JOIN purchase_invoice_lines pil
        ON pil.id = isl.purchase_invoice_line_id
       AND pil.is_receipt_eligible = true
      LEFT JOIN import_receipt_links l ON l.import_shipment_line_id = isl.id
      GROUP BY isl.id, isl.planned_quantity
      HAVING isl.planned_quantity - COALESCE(SUM(l.linked_quantity)
               FILTER (WHERE l.status = 'ACTIVE'), 0) > 0
    `);
    if (pending.length > 0) {
      throw new BusinessConflictException({
        message: `No se puede completar la operación: quedan ${pending.length} línea(s) de embarque con cantidad pendiente de recibir. No se registró ningún cambio`,
        code: 'IMPORT_PENDING_QUANTITIES',
      });
    }
    await this.operationsService.completeInTransaction(tx, {
      importOperationId: input.importOperationId,
      actorUserId: input.actorUserId,
      ipAddress: input.ipAddress,
    });
    await tx.importReceivingRequest.update({
      where: { id: requestId },
      data: { completedOperation: true },
    });
    return true;
  }

  private async buildResult(
    requestId: string,
    idempotentReplay: boolean,
    input: CommonInput,
  ): Promise<ImportReceivingResult> {
    const request = await this.prisma.importReceivingRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: {
        id: true,
        mode: true,
        completedOperation: true,
        purchaseReceiptId: true,
        receiptLinks: {
          select: IMPORT_RECEIPT_LINK_SAFE_SELECT,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    const [receipt, operation] = await Promise.all([
      request.purchaseReceiptId === null
        ? Promise.resolve(null)
        : this.receiptsService.findOne(
            request.purchaseReceiptId,
            input.requesterRole,
          ),
      this.operationsService.findOne(
        input.importOperationId,
        input.requesterRole,
      ),
    ]);
    return {
      requestId: request.id,
      idempotentReplay,
      mode: request.mode,
      receipt,
      links: request.receiptLinks.map(toSafeImportReceiptLink),
      operationCompleted: request.completedOperation,
      operation,
    };
  }

  private operationBlockReason(
    status: ImportOperationStatus,
    purchaseInvoiceId: string | null,
    invoiceStatus: PurchaseInvoiceStatus | null,
  ): string | null {
    if (purchaseInvoiceId === null) {
      return 'La operación es histórica y no está vinculada a una factura de compra';
    }
    if (status !== ImportOperationStatus.IN_PROGRESS) {
      return 'La operación no está IN_PROGRESS';
    }
    if (invoiceStatus !== PurchaseInvoiceStatus.CONFIRMED) {
      return 'La factura de compra vinculada no está CONFIRMED';
    }
    return null;
  }

  private closeBlockReason(
    status: ImportOperationStatus,
    shipmentStatuses: ImportShipmentStatus[],
    pendingTotal: Prisma.Decimal,
  ): string | null {
    if (status !== ImportOperationStatus.IN_PROGRESS) {
      return 'La operación no está IN_PROGRESS';
    }
    if (
      shipmentStatuses.some(
        (s) =>
          s === ImportShipmentStatus.PLANNED ||
          s === ImportShipmentStatus.IN_TRANSIT,
      )
    ) {
      return 'Hay embarques PLANNED o IN_TRANSIT';
    }
    if (pendingTotal.greaterThan(0)) {
      return 'Quedan cantidades pendientes de recibir';
    }
    return null;
  }

  private requireIdempotencyKey(value: string | undefined): string {
    const trimmed = value?.trim() ?? '';
    if (trimmed.length === 0) {
      throw new FieldBadRequestException({
        message:
          'La cabecera Idempotency-Key es obligatoria (protege contra doble clic y reintentos)',
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        field: 'Idempotency-Key',
        type: 'REQUIRED',
      });
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(trimmed)) {
      throw new FieldBadRequestException({
        message:
          'Idempotency-Key inválida: use 1 a 100 caracteres alfanuméricos, punto, guion, guion bajo o dos puntos',
        code: 'IDEMPOTENCY_KEY_INVALID',
        field: 'Idempotency-Key',
        type: 'FORMAT',
      });
    }
    return trimmed;
  }

  private hash(payload: unknown): string {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }
}

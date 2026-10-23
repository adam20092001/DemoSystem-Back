import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  ImportOperationStatus,
  ImportShipmentStatus,
  Prisma,
  RoleName,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import {
  businessToday,
  isValidDateOnly,
  toPrismaDate,
} from '../common/date/business-date';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import {
  IMPORT_SHIPMENT_SAFE_SELECT,
  toSafeImportShipment,
} from './mappers/import-shipment.mapper';
import { CreateImportShipmentInput } from './types/create-import-shipment.input';
import {
  ArriveImportShipmentInput,
  CancelImportShipmentInput,
  DepartImportShipmentInput,
} from './types/import-shipment-action.input';
import { ImportShipmentLineInput } from './types/import-shipment-line.input';
import { LockedPurchaseInvoiceLineRow } from './types/locked-purchase-invoice-line.row';
import { SafeImportShipment } from './types/safe-import-shipment';
import { UpdateImportShipmentInput } from './types/update-import-shipment.input';

const DEFAULT_PAGE = 1;
const MAX_LIMIT = 100;
const ZERO = new Prisma.Decimal(0);

const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
]);

function assertCanRead(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar embarques de importación',
    );
  }
}

interface LockedShipmentRow {
  id: string;
  importOperationId: string;
  status: ImportShipmentStatus;
}

/**
 * Embarques logísticos de una ImportOperation (Fase B1) — NUNCA llama a
 * StockMovementEngine/InventoryValuationEngine/AccountingEngine: ningún
 * movimiento físico ni efecto contable ocurre aquí (CLAUDE.md B1 §4/§5).
 * El vínculo opcional hacia PurchaseInvoiceLine es puramente logístico;
 * nunca modifica PurchaseInvoice/PurchaseInvoiceLine, solo lee bajo lock
 * para proteger la asignación contra sobre-asignación concurrente.
 */
@Injectable()
export class ImportShipmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(input: CreateImportShipmentInput): Promise<SafeImportShipment> {
    const carrierName = normalizeOptionalText(input.carrierName, 150);
    const trackingReference = normalizeOptionalText(
      input.trackingReference,
      100,
    );
    const billOfLadingNumber = normalizeOptionalText(
      input.billOfLadingNumber,
      100,
    );
    const containerReference = normalizeOptionalText(
      input.containerReference,
      100,
    );
    const originLocation = normalizeOptionalText(input.originLocation, 150);
    const destinationLocation = normalizeOptionalText(
      input.destinationLocation,
      150,
    );
    const notes = normalizeOptionalText(input.notes, 1000);
    const estimatedDepartureDate = normalizeOptionalDateOnly(
      input.estimatedDepartureDate,
      'estimatedDepartureDate',
    );
    const estimatedArrivalDate = normalizeOptionalDateOnly(
      input.estimatedArrivalDate,
      'estimatedArrivalDate',
    );

    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new BadRequestException(
        'El embarque debe tener al menos una línea de contenido',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const operation = await this.lockOperation(tx, input.importOperationId);
      if (
        operation.status === ImportOperationStatus.COMPLETED ||
        operation.status === ImportOperationStatus.CANCELLED
      ) {
        throw new ConflictException(
          'No se puede agregar un embarque a una operación COMPLETED o CANCELLED',
        );
      }

      const resolvedLines = await this.resolveAndValidateLines(tx, input.lines);

      const created = await tx.importShipment.create({
        data: {
          importOperationId: input.importOperationId,
          transportMode: input.transportMode,
          carrierName,
          trackingReference,
          billOfLadingNumber,
          containerReference,
          originLocation,
          destinationLocation,
          estimatedDepartureDate,
          estimatedArrivalDate,
          notes,
          createdByUserId: input.actorUserId,
          lines: { create: resolvedLines },
        },
        select: IMPORT_SHIPMENT_SAFE_SELECT,
      });

      // Transición automática DRAFT->IN_PROGRESS (nunca manual, ver
      // ImportOperationsService): el primer embarque de una operación
      // marca el inicio de actividad logística real.
      if (operation.status === ImportOperationStatus.DRAFT) {
        await tx.importOperation.update({
          where: { id: input.importOperationId },
          data: { status: ImportOperationStatus.IN_PROGRESS },
        });
      }

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_SHIPMENT_CREATED,
        entityType: 'ImportShipment',
        entityId: created.id,
        description: `Embarque ${created.id} creado`,
        metadata: {
          importOperationId: input.importOperationId,
          importShipmentId: created.id,
          lineCount: resolvedLines.length,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportShipment(created);
    });
  }

  async listByOperation(
    importOperationId: string,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeImportShipment>> {
    assertCanRead(requesterRole);

    const operation = await this.prisma.importOperation.findUnique({
      where: { id: importOperationId },
      select: { id: true },
    });
    if (operation === null) {
      throw new NotFoundException('Operación de importación no encontrada');
    }

    const [rows, total] = await Promise.all([
      this.prisma.importShipment.findMany({
        where: { importOperationId },
        select: IMPORT_SHIPMENT_SAFE_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: MAX_LIMIT,
      }),
      this.prisma.importShipment.count({ where: { importOperationId } }),
    ]);

    return {
      data: rows.map(toSafeImportShipment),
      page: DEFAULT_PAGE,
      limit: MAX_LIMIT,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / MAX_LIMIT),
    };
  }

  async findOne(
    importShipmentId: string,
    requesterRole: RoleName,
  ): Promise<SafeImportShipment> {
    assertCanRead(requesterRole);
    const row = await this.prisma.importShipment.findUnique({
      where: { id: importShipmentId },
      select: IMPORT_SHIPMENT_SAFE_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('Embarque de importación no encontrado');
    }
    return toSafeImportShipment(row);
  }

  /**
   * Edición mientras PLANNED únicamente (CLAUDE.md B1 §2: "prevent
   * modification of historical facts through unrestricted PATCH
   * operations"). `lines`, si se provee, reemplaza el arreglo completo
   * (deleteMany + createMany dentro de la MISMA transacción que revalida
   * la asignación) — mismo patrón que PurchaseInvoiceLine.
   */
  async update(input: UpdateImportShipmentInput): Promise<SafeImportShipment> {
    const hasAnyField =
      input.transportMode !== undefined ||
      input.carrierName !== undefined ||
      input.trackingReference !== undefined ||
      input.billOfLadingNumber !== undefined ||
      input.containerReference !== undefined ||
      input.originLocation !== undefined ||
      input.destinationLocation !== undefined ||
      input.estimatedDepartureDate !== undefined ||
      input.estimatedArrivalDate !== undefined ||
      input.notes !== undefined ||
      input.lines !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar',
      );
    }
    if (input.lines !== undefined && input.lines.length === 0) {
      throw new BadRequestException(
        'El embarque debe tener al menos una línea de contenido',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockShipment(tx, input.importShipmentId);
      if (locked.status !== ImportShipmentStatus.PLANNED) {
        throw new ConflictException('Solo se puede editar un embarque PLANNED');
      }

      const data: Prisma.ImportShipmentUpdateInput = {};
      const updatedFields: string[] = [];
      if (input.transportMode !== undefined) {
        data.transportMode = input.transportMode;
        updatedFields.push('transportMode');
      }
      if (input.carrierName !== undefined) {
        data.carrierName = normalizeOptionalText(input.carrierName, 150);
        updatedFields.push('carrierName');
      }
      if (input.trackingReference !== undefined) {
        data.trackingReference = normalizeOptionalText(
          input.trackingReference,
          100,
        );
        updatedFields.push('trackingReference');
      }
      if (input.billOfLadingNumber !== undefined) {
        data.billOfLadingNumber = normalizeOptionalText(
          input.billOfLadingNumber,
          100,
        );
        updatedFields.push('billOfLadingNumber');
      }
      if (input.containerReference !== undefined) {
        data.containerReference = normalizeOptionalText(
          input.containerReference,
          100,
        );
        updatedFields.push('containerReference');
      }
      if (input.originLocation !== undefined) {
        data.originLocation = normalizeOptionalText(input.originLocation, 150);
        updatedFields.push('originLocation');
      }
      if (input.destinationLocation !== undefined) {
        data.destinationLocation = normalizeOptionalText(
          input.destinationLocation,
          150,
        );
        updatedFields.push('destinationLocation');
      }
      if (input.estimatedDepartureDate !== undefined) {
        data.estimatedDepartureDate = normalizeOptionalDateOnly(
          input.estimatedDepartureDate,
          'estimatedDepartureDate',
        );
        updatedFields.push('estimatedDepartureDate');
      }
      if (input.estimatedArrivalDate !== undefined) {
        data.estimatedArrivalDate = normalizeOptionalDateOnly(
          input.estimatedArrivalDate,
          'estimatedArrivalDate',
        );
        updatedFields.push('estimatedArrivalDate');
      }
      if (input.notes !== undefined) {
        data.notes = normalizeOptionalText(input.notes, 1000);
        updatedFields.push('notes');
      }

      if (Object.keys(data).length > 0) {
        await tx.importShipment.update({
          where: { id: input.importShipmentId },
          data,
        });
      }

      let lineCount: number | undefined;
      if (input.lines !== undefined) {
        // Fase B2: nunca reemplazar silenciosamente líneas con
        // asignaciones de gasto activas (CLAUDE.md B2 §5: "Return a clear
        // 409 rather than cascading silently") — un ON DELETE Restrict de
        // la FK lo impediría igual a nivel de base de datos, pero esto da
        // un error de negocio claro ANTES de intentar el delete.
        await this.assertNoActiveExpenseAllocations(tx, input.importShipmentId);
        await tx.importShipmentLine.deleteMany({
          where: { importShipmentId: input.importShipmentId },
        });
        const resolvedLines = await this.resolveAndValidateLines(
          tx,
          input.lines,
        );
        await tx.importShipmentLine.createMany({
          data: resolvedLines.map((line) => ({
            ...line,
            importShipmentId: input.importShipmentId,
          })),
        });
        updatedFields.push('lines');
        lineCount = resolvedLines.length;
      }

      const updated = await tx.importShipment.findUniqueOrThrow({
        where: { id: input.importShipmentId },
        select: IMPORT_SHIPMENT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_SHIPMENT_UPDATED,
        entityType: 'ImportShipment',
        entityId: input.importShipmentId,
        description: `Embarque ${input.importShipmentId} actualizado`,
        metadata: {
          importShipmentId: input.importShipmentId,
          updatedFields,
          lineCount: lineCount ?? updated.lines.length,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportShipment(updated);
    });
  }

  /** PLANNED -> IN_TRANSIT. */
  async depart(input: DepartImportShipmentInput): Promise<SafeImportShipment> {
    const actualDepartureDate = normalizeOptionalDateOnly(
      input.actualDepartureDate,
      'actualDepartureDate',
    );

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockShipment(tx, input.importShipmentId);
      if (locked.status !== ImportShipmentStatus.PLANNED) {
        throw new ConflictException(
          'Solo se puede marcar en tránsito un embarque PLANNED',
        );
      }

      const updated = await tx.importShipment.update({
        where: { id: input.importShipmentId },
        data: {
          status: ImportShipmentStatus.IN_TRANSIT,
          actualDepartureDate:
            actualDepartureDate ?? toPrismaDate(businessToday()),
        },
        select: IMPORT_SHIPMENT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_SHIPMENT_DEPARTED,
        entityType: 'ImportShipment',
        entityId: input.importShipmentId,
        description: `Embarque ${input.importShipmentId} en tránsito`,
        metadata: { importShipmentId: input.importShipmentId },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportShipment(updated);
    });
  }

  /**
   * PLANNED o IN_TRANSIT -> ARRIVED. ARRIVED es un hecho LOGÍSTICO
   * (llegada a destino) — nunca una recepción física de inventario
   * (CLAUDE.md B1 §2, separación crítica con §4): no se llama a
   * StockMovementEngine ni se asume ningún movimiento de stock.
   */
  async arrive(input: ArriveImportShipmentInput): Promise<SafeImportShipment> {
    const actualArrivalDate = normalizeOptionalDateOnly(
      input.actualArrivalDate,
      'actualArrivalDate',
    );

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockShipment(tx, input.importShipmentId);
      if (
        locked.status !== ImportShipmentStatus.PLANNED &&
        locked.status !== ImportShipmentStatus.IN_TRANSIT
      ) {
        throw new ConflictException(
          'Solo se puede marcar como llegado un embarque PLANNED o IN_TRANSIT',
        );
      }

      const updated = await tx.importShipment.update({
        where: { id: input.importShipmentId },
        data: {
          status: ImportShipmentStatus.ARRIVED,
          actualArrivalDate: actualArrivalDate ?? toPrismaDate(businessToday()),
        },
        select: IMPORT_SHIPMENT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_SHIPMENT_ARRIVED,
        entityType: 'ImportShipment',
        entityId: input.importShipmentId,
        description: `Embarque ${input.importShipmentId} llegó a destino`,
        metadata: { importShipmentId: input.importShipmentId },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportShipment(updated);
    });
  }

  /** PLANNED o IN_TRANSIT -> CANCELLED. Nunca desde ARRIVED (terminal en sentido físico). */
  async cancel(input: CancelImportShipmentInput): Promise<SafeImportShipment> {
    const reason = normalizeRequiredText(input.reason, 'reason', 300);

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockShipment(tx, input.importShipmentId);
      if (
        locked.status !== ImportShipmentStatus.PLANNED &&
        locked.status !== ImportShipmentStatus.IN_TRANSIT
      ) {
        throw new ConflictException(
          'Solo se puede anular un embarque PLANNED o IN_TRANSIT',
        );
      }

      // Fase B2: nunca anular un embarque con asignaciones de gasto
      // activas apuntando a sus líneas (CLAUDE.md B2 §5) — 409 explícito,
      // nunca cascada silenciosa.
      await this.assertNoActiveExpenseAllocations(tx, input.importShipmentId);

      const previousStatus = locked.status;
      const updated = await tx.importShipment.update({
        where: { id: input.importShipmentId },
        data: {
          status: ImportShipmentStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledByUserId: input.actorUserId,
          cancellationReason: reason,
        },
        select: IMPORT_SHIPMENT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_SHIPMENT_CANCELLED,
        entityType: 'ImportShipment',
        entityId: input.importShipmentId,
        description: `Embarque ${input.importShipmentId} anulado`,
        metadata: { importShipmentId: input.importShipmentId, previousStatus },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportShipment(updated);
    });
  }

  // ==================================================================
  // Helpers privados
  // ==================================================================

  private async lockOperation(
    tx: Prisma.TransactionClient,
    importOperationId: string,
  ): Promise<{ id: string; status: ImportOperationStatus }> {
    const rows = await tx.$queryRaw<
      { id: string; status: ImportOperationStatus }[]
    >(Prisma.sql`
      SELECT id, status
      FROM import_operations
      WHERE id = ${importOperationId}::uuid
      FOR UPDATE
    `);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('Operación de importación no encontrada');
    }
    return row;
  }

  private async lockShipment(
    tx: Prisma.TransactionClient,
    importShipmentId: string,
  ): Promise<LockedShipmentRow> {
    const rows = await tx.$queryRaw<LockedShipmentRow[]>(Prisma.sql`
      SELECT id, import_operation_id AS "importOperationId", status
      FROM import_shipments
      WHERE id = ${importShipmentId}::uuid
      FOR UPDATE
    `);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('Embarque de importación no encontrado');
    }
    return row;
  }

  /**
   * Fase B2: bloquea (409) si alguna línea ACTUAL de este embarque tiene
   * al menos una ImportExpenseAllocation — nunca permite que la
   * anulación del embarque o el reemplazo de sus líneas deje asignaciones
   * de gasto apuntando a cargamento inválido/inexistente (CLAUDE.md B2
   * §5: "Return a clear 409 rather than cascading silently").
   */
  private async assertNoActiveExpenseAllocations(
    tx: Prisma.TransactionClient,
    importShipmentId: string,
  ): Promise<void> {
    const existing = await tx.importExpenseAllocation.findFirst({
      where: { importShipmentLine: { importShipmentId } },
      select: { id: true },
    });
    if (existing !== null) {
      throw new ConflictException(
        'No se puede anular ni reemplazar las líneas de este embarque: tiene asignaciones de gasto de importación registradas contra su cargamento',
      );
    }
  }

  /**
   * Resuelve y valida cada línea de contenido: producto existente (si se
   * provee), descripción (copiada de Product.name si se omite y hay
   * producto), cantidad positiva, y — si referencia una
   * PurchaseInvoiceLine — consistencia de producto y PROTECCIÓN REAL de
   * sobre-asignación bajo lock transaccional (CLAUDE.md B1 §3/§7: "Do not
   * exceed the invoice line quantity across linked shipment lines,
   * including concurrent operations").
   */
  private async resolveAndValidateLines(
    tx: Prisma.TransactionClient,
    lines: ImportShipmentLineInput[],
  ): Promise<
    {
      productId: string | null;
      descriptionSnapshot: string;
      plannedQuantity: Prisma.Decimal;
      unitCode: string | null;
      unitName: string | null;
      weightValue: Prisma.Decimal | null;
      weightUnit: string | null;
      volumeValue: Prisma.Decimal | null;
      volumeUnit: string | null;
      purchaseInvoiceLineId: string | null;
    }[]
  > {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new BadRequestException(
        'El embarque debe tener al menos una línea de contenido',
      );
    }

    const parsedQuantities = lines.map((line) =>
      this.parsePositiveDecimal(line.plannedQuantity, 'plannedQuantity'),
    );
    const parsedWeights = lines.map((line) =>
      line.weightValue !== undefined
        ? this.parseNonNegativeDecimal(line.weightValue, 'weightValue')
        : null,
    );
    const parsedVolumes = lines.map((line) =>
      line.volumeValue !== undefined
        ? this.parseNonNegativeDecimal(line.volumeValue, 'volumeValue')
        : null,
    );

    const productIds = Array.from(
      new Set(
        lines
          .map((l) => l.productId)
          .filter((id): id is string => id !== undefined),
      ),
    );
    const products =
      productIds.length === 0
        ? []
        : await tx.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, name: true },
          });
    const productById = new Map(products.map((p) => [p.id, p]));
    for (const id of productIds) {
      if (!productById.has(id)) {
        throw new BadRequestException(`El producto ${id} no existe`);
      }
    }

    // --- Protección de sobre-asignación contra PurchaseInvoiceLine ---
    const invoiceLineIds = Array.from(
      new Set(
        lines
          .map((l) => l.purchaseInvoiceLineId)
          .filter((id): id is string => id !== undefined),
      ),
    ).sort();
    const lockedInvoiceLineById = new Map<
      string,
      LockedPurchaseInvoiceLineRow
    >();
    if (invoiceLineIds.length > 0) {
      const lockedLines = await tx.$queryRaw<LockedPurchaseInvoiceLineRow[]>(
        Prisma.sql`
          SELECT pil.id, pil.quantity, pil.product_id AS "productId",
                 pi.status AS "invoiceStatus"
          FROM purchase_invoice_lines pil
          JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id
          WHERE pil.id = ANY(${invoiceLineIds}::uuid[])
          ORDER BY pil.id ASC
          FOR UPDATE OF pil
        `,
      );
      if (lockedLines.length !== invoiceLineIds.length) {
        throw new BadRequestException(
          'Alguna línea de factura de compra referenciada no existe',
        );
      }
      for (const row of lockedLines) {
        lockedInvoiceLineById.set(row.id, row);
        if (row.invoiceStatus !== 'CONFIRMED') {
          throw new ConflictException(
            `La línea de factura ${row.id} no pertenece a una factura de compra CONFIRMED`,
          );
        }
      }

      const existingAllocations = await tx.importShipmentLine.groupBy({
        by: ['purchaseInvoiceLineId'],
        where: {
          purchaseInvoiceLineId: { in: invoiceLineIds },
          importShipment: { status: { not: ImportShipmentStatus.CANCELLED } },
        },
        _sum: { plannedQuantity: true },
      });
      const existingByLineId = new Map(
        existingAllocations
          .filter((a) => a.purchaseInvoiceLineId !== null)
          .map((a) => [
            a.purchaseInvoiceLineId as string,
            a._sum.plannedQuantity ?? ZERO,
          ]),
      );

      const requestedByLineId = new Map<string, Prisma.Decimal>();
      for (const [index, line] of lines.entries()) {
        if (line.purchaseInvoiceLineId === undefined) {
          continue;
        }
        const prev = requestedByLineId.get(line.purchaseInvoiceLineId) ?? ZERO;
        requestedByLineId.set(
          line.purchaseInvoiceLineId,
          prev.plus(parsedQuantities[index]),
        );
      }

      for (const [invoiceLineId, requestedQty] of requestedByLineId) {
        const row = lockedInvoiceLineById.get(invoiceLineId);
        if (row === undefined) {
          throw new InternalServerErrorException(
            'Línea de factura bloqueada sin fila correspondiente; invariante interno roto',
          );
        }
        const existing = existingByLineId.get(invoiceLineId) ?? ZERO;
        if (existing.plus(requestedQty).greaterThan(row.quantity)) {
          throw new ConflictException(
            `La cantidad planificada excede lo facturado para la línea de factura ${invoiceLineId}`,
          );
        }
      }
    }

    return lines.map((line, index) => {
      let productId: string | null = line.productId ?? null;
      let descriptionSnapshot = line.descriptionSnapshot?.trim() ?? '';

      if (line.purchaseInvoiceLineId !== undefined) {
        const invoiceLine = lockedInvoiceLineById.get(
          line.purchaseInvoiceLineId,
        );
        if (invoiceLine === undefined) {
          throw new InternalServerErrorException(
            'Línea de factura bloqueada sin fila correspondiente; invariante interno roto',
          );
        }
        if (
          invoiceLine.productId !== null &&
          productId !== null &&
          productId !== invoiceLine.productId
        ) {
          throw new BadRequestException(
            'El producto de la línea no coincide con el de la factura de compra referenciada',
          );
        }
        if (productId === null && invoiceLine.productId !== null) {
          productId = invoiceLine.productId;
        }
      }

      if (descriptionSnapshot.length === 0) {
        if (productId !== null) {
          const product = productById.get(productId);
          descriptionSnapshot = product?.name ?? '';
        }
        if (descriptionSnapshot.length === 0) {
          throw new BadRequestException(
            'descriptionSnapshot es obligatorio cuando la línea no referencia un producto existente',
          );
        }
      }
      if (descriptionSnapshot.length > 300) {
        throw new BadRequestException(
          'descriptionSnapshot no puede superar los 300 caracteres',
        );
      }

      return {
        productId,
        descriptionSnapshot,
        plannedQuantity: parsedQuantities[index],
        unitCode: normalizeOptionalText(line.unitCode, 15),
        unitName: normalizeOptionalText(line.unitName, 60),
        weightValue: parsedWeights[index],
        weightUnit: normalizeOptionalText(line.weightUnit, 10),
        volumeValue: parsedVolumes[index],
        volumeUnit: normalizeOptionalText(line.volumeUnit, 10),
        purchaseInvoiceLineId: line.purchaseInvoiceLineId ?? null,
      };
    });
  }

  private parsePositiveDecimal(raw: string, fieldName: string): Prisma.Decimal {
    const value = this.parseDecimalInput(raw, fieldName);
    if (value.lessThanOrEqualTo(0)) {
      throw new BadRequestException(`${fieldName} debe ser mayor que cero`);
    }
    return value;
  }

  private parseNonNegativeDecimal(
    raw: string,
    fieldName: string,
  ): Prisma.Decimal {
    const value = this.parseDecimalInput(raw, fieldName);
    if (value.lessThan(0)) {
      throw new BadRequestException(`${fieldName} no puede ser negativo`);
    }
    return value;
  }

  private parseDecimalInput(raw: string, fieldName: string): Prisma.Decimal {
    try {
      const value = new Prisma.Decimal(raw);
      if (!value.isFinite()) {
        throw new Error('not finite');
      }
      return value;
    } catch {
      throw new BadRequestException(`${fieldName} no es un decimal válido`);
    }
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

function normalizeOptionalDateOnly(
  value: string | null | undefined,
  fieldName: string,
): Date | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isValidDateOnly(value)) {
    throw new BadRequestException(
      `${fieldName} debe ser una fecha real en formato YYYY-MM-DD`,
    );
  }
  return toPrismaDate(value);
}

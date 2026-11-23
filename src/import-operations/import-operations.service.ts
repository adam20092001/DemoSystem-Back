import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ImportOperationStatus,
  ImportShipmentStatus,
  Prisma,
  PurchaseInvoiceStatus,
  PurchaseReceiptStatus,
  RoleName,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { businessToday } from '../common/date/business-date';
import {
  BusinessConflictException,
  FieldBadRequestException,
} from '../common/errors/error-contract';
import { PaginatedResult } from '../common/types/paginated-result';
import { assertCountryUsable } from '../countries/country.utils';
import { PrismaService } from '../database/prisma.service';
import {
  formatImportOperationReference,
  nextImportOperationNumber,
  yearOfBusinessDate,
} from './import-operation-reference';
import {
  IMPORT_OPERATION_SAFE_SELECT,
  toSafeImportOperation,
} from './mappers/import-operation.mapper';
import {
  CancelImportOperationInput,
  CompleteImportOperationInput,
} from './types/import-operation-action.input';
import { CreateImportOperationInput } from './types/create-import-operation.input';
import { ListImportOperationsQuery } from './types/list-import-operations.query';
import {
  SafeImportInvoiceLine,
  SafeImportOperation,
} from './types/safe-import-operation';
import { UpdateImportOperationInput } from './types/update-import-operation.input';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Alcance inicial (Fase B1, CLAUDE.md §6): ADMIN administra el ciclo de
 * vida completo; MANAGEMENT/ACCOUNTANT solo leen; SELLER/WAREHOUSE sin
 * ningún acceso — mismo criterio exacto que Suppliers/PurchaseInvoices.
 */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
  RoleName.PURCHASING,
]);

function assertCanRead(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar operaciones de importación',
    );
  }
}

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/**
 * Operaciones de importación (Fase B1) — expediente genérico, reutilizable
 * por cualquier industria, deliberadamente sin supplierId/purchaseInvoiceId
 * propio (una operación consolidada puede abarcar varios proveedores; ver
 * ImportShipmentLine). Nunca calcula costos, nunca convierte moneda, nunca
 * llama a StockMovementEngine/AccountingEngine/InventoryValuationEngine —
 * B1 es exclusivamente planificación y seguimiento logístico.
 */
@Injectable()
export class ImportOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(
    input: CreateImportOperationInput,
  ): Promise<SafeImportOperation> {
    const originCountry = normalizeCountryCode(
      input.originCountry,
      'originCountry',
    );
    const destinationCountry = normalizeCountryCode(
      input.destinationCountry,
      'destinationCountry',
    );
    const description = normalizeOptionalText(input.description, 300);
    const externalReference = normalizeOptionalText(
      input.externalReference,
      100,
    );
    const notes = normalizeOptionalText(input.notes, 1000);

    return this.prisma.$transaction(async (tx) => {
      // R4: países del catálogo compartido (existentes y activos).
      await assertCountryUsable(tx, originCountry, 'originCountry');
      await assertCountryUsable(tx, destinationCountry, 'destinationCountry');

      // R4: factura de compra principal OBLIGATORIA en operaciones nuevas.
      // FOR SHARE: impide que PurchaseInvoicesService.cancel() (que toma
      // FOR UPDATE sobre la factura) anule la compra entre esta validación y
      // el commit; el orden de locks es siempre factura primero.
      const invoiceRows = await tx.$queryRaw<
        { id: string; status: PurchaseInvoiceStatus }[]
      >(Prisma.sql`
        SELECT id, status FROM purchase_invoices
        WHERE id = ${input.purchaseInvoiceId}::uuid
        FOR SHARE
      `);
      const invoice = invoiceRows[0];
      if (invoice === undefined) {
        throw new FieldBadRequestException({
          message: 'La factura de compra indicada no existe',
          code: 'PURCHASE_INVOICE_NOT_FOUND',
          field: 'purchaseInvoiceId',
        });
      }
      if (invoice.status === PurchaseInvoiceStatus.CANCELLED) {
        throw new BusinessConflictException({
          message:
            'No se puede crear una importación sobre una factura de compra anulada',
          code: 'PURCHASE_INVOICE_CANCELLED',
          field: 'purchaseInvoiceId',
        });
      }

      // R4: correlativo anual generado en el servidor (IMP-AAAA-NNNNNN).
      // El año es el de la zona de negocio; el índice único funcional de
      // `reference` es la segunda defensa ante cualquier carrera.
      const year = yearOfBusinessDate(businessToday());
      const sequence = await nextImportOperationNumber(tx, year);
      const reference = formatImportOperationReference(year, sequence);

      const created = await tx.importOperation.create({
        data: {
          reference,
          purchaseInvoiceId: input.purchaseInvoiceId,
          isLegacyUnlinked: false,
          description,
          originCountry,
          destinationCountry,
          externalReference,
          notes,
          status: ImportOperationStatus.DRAFT,
          createdByUserId: input.actorUserId,
        },
        select: IMPORT_OPERATION_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_OPERATION_CREATED,
        entityType: 'ImportOperation',
        entityId: created.id,
        description: `Operación de importación ${created.id} creada`,
        metadata: {
          importOperationId: created.id,
          purchaseInvoiceId: input.purchaseInvoiceId,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportOperation(created);
    });
  }

  async list(
    query: ListImportOperationsQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeImportOperation>> {
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

    if (!READ_ROLES.has(requesterRole)) {
      return { data: [], page, limit, total: 0, totalPages: 0 };
    }

    const where: Prisma.ImportOperationWhereInput = {};
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.purchaseInvoiceId !== undefined) {
      where.purchaseInvoiceId = query.purchaseInvoiceId;
    }
    if (query.isLegacyUnlinked !== undefined) {
      where.isLegacyUnlinked = query.isLegacyUnlinked;
    }
    if (query.originCountry !== undefined) {
      where.originCountry = query.originCountry.trim().toUpperCase();
    }
    if (query.destinationCountry !== undefined) {
      where.destinationCountry = query.destinationCountry.trim().toUpperCase();
    }
    const term = query.search?.trim();
    if (term !== undefined && term.length > 0) {
      where.OR = [
        { reference: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        { externalReference: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.importOperation.findMany({
        where,
        select: IMPORT_OPERATION_SAFE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.importOperation.count({ where }),
    ]);

    return {
      data: rows.map(toSafeImportOperation),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findOne(
    importOperationId: string,
    requesterRole: RoleName,
  ): Promise<SafeImportOperation> {
    assertCanRead(requesterRole);
    const row = await this.prisma.importOperation.findUnique({
      where: { id: importOperationId },
      select: IMPORT_OPERATION_SAFE_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('Operación de importación no encontrada');
    }
    const safe = toSafeImportOperation(row);
    if (row.purchaseInvoiceId !== null) {
      safe.invoiceLines = await this.loadInvoiceLines(
        row.purchaseInvoiceId,
        row.id,
      );
    }
    return safe;
  }

  /**
   * Productos y líneas de la compra con su disponibilidad logística (R4).
   * Solo lectura: nunca escribe stock, valorización ni contabilidad.
   */
  private async loadInvoiceLines(
    purchaseInvoiceId: string,
    importOperationId: string,
  ): Promise<SafeImportInvoiceLine[]> {
    const lines = await this.prisma.purchaseInvoiceLine.findMany({
      where: { purchaseInvoiceId },
      select: {
        id: true,
        productId: true,
        descriptionSnapshot: true,
        unitCodeSnapshot: true,
        quantity: true,
        product: { select: { sku: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const lineIds = lines.map((line) => line.id);
    if (lineIds.length === 0) {
      return [];
    }
    const [assignedAll, assignedThis, received] = await Promise.all([
      this.prisma.importShipmentLine.groupBy({
        by: ['purchaseInvoiceLineId'],
        where: {
          purchaseInvoiceLineId: { in: lineIds },
          importShipment: { status: { not: ImportShipmentStatus.CANCELLED } },
        },
        _sum: { plannedQuantity: true },
      }),
      this.prisma.importShipmentLine.groupBy({
        by: ['purchaseInvoiceLineId'],
        where: {
          purchaseInvoiceLineId: { in: lineIds },
          importShipment: {
            importOperationId,
            status: { not: ImportShipmentStatus.CANCELLED },
          },
        },
        _sum: { plannedQuantity: true },
      }),
      this.prisma.purchaseReceiptLine.groupBy({
        by: ['purchaseInvoiceLineId'],
        where: {
          purchaseInvoiceLineId: { in: lineIds },
          purchaseReceipt: { status: PurchaseReceiptStatus.ACTIVE },
        },
        _sum: { quantity: true },
      }),
    ]);
    const zero = new Prisma.Decimal(0);
    const assignedAllMap = new Map(
      assignedAll.map((r) => [
        r.purchaseInvoiceLineId,
        r._sum.plannedQuantity ?? zero,
      ]),
    );
    const assignedThisMap = new Map(
      assignedThis.map((r) => [
        r.purchaseInvoiceLineId,
        r._sum.plannedQuantity ?? zero,
      ]),
    );
    const receivedMap = new Map(
      received.map((r) => [r.purchaseInvoiceLineId, r._sum.quantity ?? zero]),
    );
    return lines.map((line) => {
      const assigned = assignedAllMap.get(line.id) ?? zero;
      const receivedQty = receivedMap.get(line.id) ?? zero;
      const available = line.quantity.minus(assigned);
      const pending = line.quantity.minus(receivedQty);
      return {
        purchaseInvoiceLineId: line.id,
        productId: line.productId,
        productSku: line.product?.sku ?? null,
        description: line.descriptionSnapshot,
        unitCode: line.unitCodeSnapshot,
        invoicedQuantity: line.quantity.toFixed(3),
        assignedQuantity: assigned.toFixed(3),
        assignedToThisOperationQuantity: (
          assignedThisMap.get(line.id) ?? zero
        ).toFixed(3),
        availableQuantity: (available.lessThan(0) ? zero : available).toFixed(
          3,
        ),
        receivedQuantity: receivedQty.toFixed(3),
        pendingReceiptQuantity: (pending.lessThan(0) ? zero : pending).toFixed(
          3,
        ),
      };
    });
  }

  async update(
    input: UpdateImportOperationInput,
  ): Promise<SafeImportOperation> {
    const hasAnyField =
      input.description !== undefined ||
      input.originCountry !== undefined ||
      input.destinationCountry !== undefined ||
      input.externalReference !== undefined ||
      input.notes !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.importOperation.findUnique({
        where: { id: input.importOperationId },
        select: {
          id: true,
          status: true,
          originCountry: true,
          destinationCountry: true,
        },
      });
      if (existing === null) {
        throw new NotFoundException('Operación de importación no encontrada');
      }
      if (
        existing.status === ImportOperationStatus.COMPLETED ||
        existing.status === ImportOperationStatus.CANCELLED
      ) {
        throw new ConflictException(
          'No se puede editar una operación COMPLETED o CANCELLED',
        );
      }

      const data: Prisma.ImportOperationUncheckedUpdateInput = {};
      const updatedFields: string[] = [];

      if (input.description !== undefined) {
        data.description = normalizeOptionalText(input.description, 300);
        updatedFields.push('description');
      }
      if (input.originCountry !== undefined) {
        const newOrigin = normalizeCountryCode(
          input.originCountry,
          'originCountry',
        );
        if (newOrigin !== existing.originCountry) {
          await assertCountryUsable(tx, newOrigin, 'originCountry');
        }
        data.originCountry = newOrigin;
        updatedFields.push('originCountry');
      }
      if (input.destinationCountry !== undefined) {
        const newDestination = normalizeCountryCode(
          input.destinationCountry,
          'destinationCountry',
        );
        if (newDestination !== existing.destinationCountry) {
          await assertCountryUsable(tx, newDestination, 'destinationCountry');
        }
        data.destinationCountry = newDestination;
        updatedFields.push('destinationCountry');
      }
      if (input.externalReference !== undefined) {
        data.externalReference = normalizeOptionalText(
          input.externalReference,
          100,
        );
        updatedFields.push('externalReference');
      }
      if (input.notes !== undefined) {
        data.notes = normalizeOptionalText(input.notes, 1000);
        updatedFields.push('notes');
      }

      const updated = await tx.importOperation.update({
        where: { id: input.importOperationId },
        data,
        select: IMPORT_OPERATION_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_OPERATION_UPDATED,
        entityType: 'ImportOperation',
        entityId: input.importOperationId,
        description: `Operación de importación ${input.importOperationId} actualizada`,
        metadata: { importOperationId: input.importOperationId, updatedFields },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportOperation(updated);
    });
  }

  /**
   * Cierre OPERATIVO/logístico explícito — NUNCA financiero/contable
   * (CLAUDE.md B1 §1). Exige status=IN_PROGRESS (una operación DRAFT nunca
   * tuvo actividad logística real que completar) y que ningún embarque
   * esté todavía PLANNED/IN_TRANSIT.
   */
  async complete(
    input: CompleteImportOperationInput,
  ): Promise<SafeImportOperation> {
    return this.prisma.$transaction((tx) =>
      this.completeInTransaction(tx, input),
    );
  }

  /**
   * R5: mismo cierre OPERATIVO dentro de una transacción ya abierta (recibir y
   * completar). No mueve stock ni genera efectos contables.
   */
  async completeInTransaction(
    tx: Prisma.TransactionClient,
    input: CompleteImportOperationInput,
  ): Promise<SafeImportOperation> {
    {
      const locked = await this.lockOperation(tx, input.importOperationId);
      if (locked.status !== ImportOperationStatus.IN_PROGRESS) {
        throw new ConflictException(
          'Solo se puede completar una operación IN_PROGRESS',
        );
      }

      const pendingShipment = await tx.importShipment.findFirst({
        where: {
          importOperationId: input.importOperationId,
          status: {
            in: [ImportShipmentStatus.PLANNED, ImportShipmentStatus.IN_TRANSIT],
          },
        },
        select: { id: true },
      });
      if (pendingShipment !== null) {
        throw new ConflictException(
          'No se puede completar la operación: tiene embarques PLANNED o IN_TRANSIT',
        );
      }

      const updated = await tx.importOperation.update({
        where: { id: input.importOperationId },
        data: {
          status: ImportOperationStatus.COMPLETED,
          completedAt: new Date(),
          completedByUserId: input.actorUserId,
        },
        select: IMPORT_OPERATION_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_OPERATION_COMPLETED,
        entityType: 'ImportOperation',
        entityId: input.importOperationId,
        description: `Operación de importación ${input.importOperationId} completada`,
        metadata: { importOperationId: input.importOperationId },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportOperation(updated);
    }
  }

  /**
   * DRAFT o IN_PROGRESS -> CANCELLED. Bloqueada si algún embarque ya está
   * ARRIVED (la mercadería llegó a destino logístico; cancelar toda la
   * operación ya no tiene sentido operativo).
   */
  async cancel(
    input: CancelImportOperationInput,
  ): Promise<SafeImportOperation> {
    const reason = normalizeRequiredText(input.reason, 'reason', 300);

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockOperation(tx, input.importOperationId);
      if (
        locked.status !== ImportOperationStatus.DRAFT &&
        locked.status !== ImportOperationStatus.IN_PROGRESS
      ) {
        throw new ConflictException(
          'Solo se puede anular una operación DRAFT o IN_PROGRESS',
        );
      }

      const arrivedShipment = await tx.importShipment.findFirst({
        where: {
          importOperationId: input.importOperationId,
          status: ImportShipmentStatus.ARRIVED,
        },
        select: { id: true },
      });
      if (arrivedShipment !== null) {
        throw new ConflictException(
          'No se puede anular la operación: tiene al menos un embarque ARRIVED',
        );
      }

      const previousStatus = locked.status;
      const updated = await tx.importOperation.update({
        where: { id: input.importOperationId },
        data: {
          status: ImportOperationStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledByUserId: input.actorUserId,
          cancellationReason: reason,
        },
        select: IMPORT_OPERATION_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_OPERATION_CANCELLED,
        entityType: 'ImportOperation',
        entityId: input.importOperationId,
        description: `Operación de importación ${input.importOperationId} anulada`,
        metadata: {
          importOperationId: input.importOperationId,
          previousStatus,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportOperation(updated);
    });
  }

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

function normalizeCountryCode(value: string, fieldName: string): string {
  const normalized = value.trim().toUpperCase();
  if (!COUNTRY_CODE_PATTERN.test(normalized)) {
    throw new BadRequestException(
      `${fieldName} debe ser un código ISO 3166-1 alpha-2 (2 letras)`,
    );
  }
  return normalized;
}

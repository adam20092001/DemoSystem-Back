import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  ImportExpenseAllocationMethod,
  ImportExpenseStatus,
  ImportShipmentStatus,
  Prisma,
  PurchaseInvoiceStatus,
  RoleName,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { isValidDateOnly, toPrismaDate } from '../common/date/business-date';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import {
  assertValidDistributionBase,
  computeProportionalAllocation,
} from './import-expense-allocation-calculator';
import {
  IMPORT_EXPENSE_ALLOCATION_BATCH_SAFE_SELECT,
  toSafeImportExpenseAllocationBatch,
} from './mappers/import-expense-allocation-batch.mapper';
import {
  IMPORT_EXPENSE_SAFE_SELECT,
  toSafeImportExpense,
} from './mappers/import-expense.mapper';
import {
  AllocateImportExpenseInput,
  ManualAllocationLineInput,
  PreviewImportExpenseAllocationInput,
} from './types/allocate-import-expense.input';
import { CreateImportExpenseInput } from './types/create-import-expense.input';
import {
  CancelImportExpenseInput,
  FinalizeImportExpenseInput,
} from './types/import-expense-action.input';
import { ListImportExpensesQuery } from './types/list-import-expenses.query';
import { LockedShipmentLineForAllocationRow } from './types/locked-shipment-line-for-allocation.row';
import { SafeImportExpense } from './types/safe-import-expense';
import { SafeImportExpenseAllocationBatch } from './types/safe-import-expense-allocation-batch';
import { UpdateImportExpenseInput } from './types/update-import-expense.input';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const ZERO = new Prisma.Decimal(0);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
]);

function assertCanRead(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar gastos de importación',
    );
  }
}

interface LockedExpenseRow {
  id: string;
  importOperationId: string;
  status: ImportExpenseStatus;
  amount: Prisma.Decimal;
}

/**
 * Gastos de importación y asignación de costo (Fase B2) — fletes,
 * seguros, aduanas, manipuleo portuario, almacenaje, transporte interno u
 * otro. NUNCA decide si un gasto es capitalizable, NUNCA calcula IGV/
 * aranceles recuperables, NUNCA crea AccountingEntry/SupplierPayment/
 * InventoryValuation/InventoryMovement (CLAUDE.md B2 §2/§6) — es
 * exclusivamente registro documental y reparto operativo preparatorio
 * para una fase futura (B3) que decidirá el tratamiento contable real.
 */
@Injectable()
export class ImportExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(input: CreateImportExpenseInput): Promise<SafeImportExpense> {
    const description = normalizeOptionalText(input.description, 300);
    const documentReference = normalizeOptionalText(
      input.documentReference,
      100,
    );
    const remarks = normalizeOptionalText(input.remarks, 1000);
    const expenseDate = normalizeRequiredDateOnly(
      input.expenseDate,
      'expenseDate',
    );
    const currencyCode = normalizeCurrencyCode(input.currencyCode);
    const amount = parsePositiveDecimal(input.amount, 'amount');

    return this.prisma.$transaction(async (tx) => {
      const operation = await tx.importOperation.findUnique({
        where: { id: input.importOperationId },
        select: { id: true },
      });
      if (operation === null) {
        throw new NotFoundException('Operación de importación no encontrada');
      }

      if (input.supplierId !== undefined) {
        await this.assertSupplierExists(tx, input.supplierId);
      }
      if (input.purchaseInvoiceLineId !== undefined) {
        await this.assertInvoiceLineConfirmed(tx, input.purchaseInvoiceLineId);
      }

      const created = await tx.importExpense.create({
        data: {
          importOperationId: input.importOperationId,
          category: input.category,
          description,
          supplierId: input.supplierId ?? null,
          purchaseInvoiceLineId: input.purchaseInvoiceLineId ?? null,
          documentType: input.documentType ?? null,
          documentReference,
          expenseDate,
          currencyCode,
          amount,
          remarks,
          status: ImportExpenseStatus.DRAFT,
          createdByUserId: input.actorUserId,
        },
        select: IMPORT_EXPENSE_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_EXPENSE_CREATED,
        entityType: 'ImportExpense',
        entityId: created.id,
        description: `Gasto de importación ${created.id} creado`,
        metadata: {
          importOperationId: input.importOperationId,
          importExpenseId: created.id,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportExpense(created);
    });
  }

  async listByOperation(
    importOperationId: string,
    query: ListImportExpensesQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeImportExpense>> {
    assertCanRead(requesterRole);

    const operation = await this.prisma.importOperation.findUnique({
      where: { id: importOperationId },
      select: { id: true },
    });
    if (operation === null) {
      throw new NotFoundException('Operación de importación no encontrada');
    }

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

    const where: Prisma.ImportExpenseWhereInput = { importOperationId };
    if (query.category !== undefined) {
      where.category = query.category;
    }
    if (query.status !== undefined) {
      where.status = query.status;
    }

    const [rows, total] = await Promise.all([
      this.prisma.importExpense.findMany({
        where,
        select: IMPORT_EXPENSE_SAFE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.importExpense.count({ where }),
    ]);

    return {
      data: rows.map(toSafeImportExpense),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findOne(
    importExpenseId: string,
    requesterRole: RoleName,
  ): Promise<SafeImportExpense> {
    assertCanRead(requesterRole);
    const row = await this.prisma.importExpense.findUnique({
      where: { id: importExpenseId },
      select: IMPORT_EXPENSE_SAFE_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('Gasto de importación no encontrado');
    }
    return toSafeImportExpense(row);
  }

  async update(input: UpdateImportExpenseInput): Promise<SafeImportExpense> {
    const hasAnyField =
      input.category !== undefined ||
      input.description !== undefined ||
      input.supplierId !== undefined ||
      input.purchaseInvoiceLineId !== undefined ||
      input.documentType !== undefined ||
      input.documentReference !== undefined ||
      input.expenseDate !== undefined ||
      input.currencyCode !== undefined ||
      input.amount !== undefined ||
      input.remarks !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.importExpense.findUnique({
        where: { id: input.importExpenseId },
        select: { id: true, status: true },
      });
      if (existing === null) {
        throw new NotFoundException('Gasto de importación no encontrado');
      }
      if (existing.status !== ImportExpenseStatus.DRAFT) {
        throw new ConflictException(
          'Solo se puede editar un gasto de importación DRAFT',
        );
      }

      if (input.amount !== undefined || input.currencyCode !== undefined) {
        const batchCount = await tx.importExpenseAllocationBatch.count({
          where: { importExpenseId: input.importExpenseId },
        });
        if (batchCount > 0) {
          throw new ConflictException(
            'No se puede modificar el monto ni la moneda: este gasto ya tiene lotes de asignación registrados',
          );
        }
      }

      const data: Prisma.ImportExpenseUncheckedUpdateInput = {};
      const updatedFields: string[] = [];

      if (input.category !== undefined) {
        data.category = input.category;
        updatedFields.push('category');
      }
      if (input.description !== undefined) {
        data.description = normalizeOptionalText(input.description, 300);
        updatedFields.push('description');
      }
      if (input.supplierId !== undefined) {
        await this.assertSupplierExists(tx, input.supplierId);
        data.supplierId = input.supplierId;
        updatedFields.push('supplierId');
      }
      if (input.purchaseInvoiceLineId !== undefined) {
        await this.assertInvoiceLineConfirmed(tx, input.purchaseInvoiceLineId);
        data.purchaseInvoiceLineId = input.purchaseInvoiceLineId;
        updatedFields.push('purchaseInvoiceLineId');
      }
      if (input.documentType !== undefined) {
        data.documentType = input.documentType;
        updatedFields.push('documentType');
      }
      if (input.documentReference !== undefined) {
        data.documentReference = normalizeOptionalText(
          input.documentReference,
          100,
        );
        updatedFields.push('documentReference');
      }
      if (input.expenseDate !== undefined) {
        data.expenseDate = normalizeRequiredDateOnly(
          input.expenseDate,
          'expenseDate',
        );
        updatedFields.push('expenseDate');
      }
      if (input.currencyCode !== undefined) {
        data.currencyCode = normalizeCurrencyCode(input.currencyCode);
        updatedFields.push('currencyCode');
      }
      if (input.amount !== undefined) {
        data.amount = parsePositiveDecimal(input.amount, 'amount');
        updatedFields.push('amount');
      }
      if (input.remarks !== undefined) {
        data.remarks = normalizeOptionalText(input.remarks, 1000);
        updatedFields.push('remarks');
      }

      const updated = await tx.importExpense.update({
        where: { id: input.importExpenseId },
        data,
        select: IMPORT_EXPENSE_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_EXPENSE_UPDATED,
        entityType: 'ImportExpense',
        entityId: input.importExpenseId,
        description: `Gasto de importación ${input.importExpenseId} actualizado`,
        metadata: { importExpenseId: input.importExpenseId, updatedFields },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportExpense(updated);
    });
  }

  /** DRAFT -> FINALIZED. Cabecera inmutable a partir de aquí; las asignaciones siguen permitidas (CLAUDE.md B2 §5). */
  async finalize(
    input: FinalizeImportExpenseInput,
  ): Promise<SafeImportExpense> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockExpense(tx, input.importExpenseId);
      if (locked.status !== ImportExpenseStatus.DRAFT) {
        throw new ConflictException(
          'Solo se puede finalizar un gasto de importación DRAFT',
        );
      }

      const updated = await tx.importExpense.update({
        where: { id: input.importExpenseId },
        data: {
          status: ImportExpenseStatus.FINALIZED,
          finalizedAt: new Date(),
          finalizedByUserId: input.actorUserId,
        },
        select: IMPORT_EXPENSE_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_EXPENSE_FINALIZED,
        entityType: 'ImportExpense',
        entityId: input.importExpenseId,
        description: `Gasto de importación ${input.importExpenseId} finalizado`,
        metadata: { importExpenseId: input.importExpenseId },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportExpense(updated);
    });
  }

  /** DRAFT o FINALIZED -> CANCELLED. Bloqueado (409) si ya existe algún lote de asignación. */
  async cancel(input: CancelImportExpenseInput): Promise<SafeImportExpense> {
    const reason = normalizeRequiredText(input.reason, 'reason', 300);

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockExpense(tx, input.importExpenseId);
      if (locked.status === ImportExpenseStatus.CANCELLED) {
        throw new ConflictException('El gasto ya está anulado');
      }

      const batchCount = await tx.importExpenseAllocationBatch.count({
        where: { importExpenseId: input.importExpenseId },
      });
      if (batchCount > 0) {
        throw new ConflictException(
          'No se puede anular: este gasto ya tiene lotes de asignación registrados',
        );
      }

      const updated = await tx.importExpense.update({
        where: { id: input.importExpenseId },
        data: {
          status: ImportExpenseStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledByUserId: input.actorUserId,
          cancellationReason: reason,
        },
        select: IMPORT_EXPENSE_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_EXPENSE_CANCELLED,
        entityType: 'ImportExpense',
        entityId: input.importExpenseId,
        description: `Gasto de importación ${input.importExpenseId} anulado`,
        metadata: { importExpenseId: input.importExpenseId },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportExpense(updated);
    });
  }

  /**
   * Crea UN lote de asignación (Fase B2) — reparte `amountToAllocate`
   * (SIEMPRE explícito, nunca asumido) entre las líneas elegibles
   * indicadas. Protegido bajo lock transaccional: el gasto se bloquea
   * primero (orden de lock consistente con las líneas, que se bloquean
   * después en orden ascendente de id) para que dos asignaciones
   * concurrentes del MISMO gasto nunca excedan `amount` en conjunto
   * (CLAUDE.md B2 §8). Idempotente: reenviar el mismo `idempotencyKey`
   * devuelve el lote ya creado, sin duplicar nada.
   */
  async allocate(
    input: AllocateImportExpenseInput,
  ): Promise<SafeImportExpenseAllocationBatch> {
    const amountToAllocate = parsePositiveDecimal(
      input.amountToAllocate,
      'amountToAllocate',
    );
    const idempotencyKey = normalizeOptionalText(input.idempotencyKey, 100);

    return this.prisma.$transaction(async (tx) => {
      const expense = await this.lockExpense(tx, input.importExpenseId);
      if (expense.status === ImportExpenseStatus.CANCELLED) {
        throw new ConflictException(
          'No se puede asignar: el gasto de importación está anulado',
        );
      }

      if (idempotencyKey !== null) {
        const existingBatch = await tx.importExpenseAllocationBatch.findUnique({
          where: {
            importExpenseId_idempotencyKey: {
              importExpenseId: input.importExpenseId,
              idempotencyKey,
            },
          },
          select: IMPORT_EXPENSE_ALLOCATION_BATCH_SAFE_SELECT,
        });
        if (existingBatch !== null) {
          return toSafeImportExpenseAllocationBatch(existingBatch);
        }
      }

      const allocatedSoFar = await this.sumActiveBatches(
        tx,
        input.importExpenseId,
      );
      if (allocatedSoFar.plus(amountToAllocate).greaterThan(expense.amount)) {
        throw new ConflictException(
          'La cantidad a asignar excede el monto disponible (no asignado) del gasto',
        );
      }

      const lineIds = this.resolveRequestedLineIds(input);
      const lockedLines = await this.lockEligibleLines(
        tx,
        expense.importOperationId,
        lineIds,
      );

      const resultLines = this.computeAllocationLines(
        input.method,
        amountToAllocate,
        lockedLines,
        input.manualAllocations,
      );

      const created = await tx.importExpenseAllocationBatch.create({
        data: {
          importExpenseId: input.importExpenseId,
          method: input.method,
          requestedAmount: amountToAllocate,
          idempotencyKey,
          createdByUserId: input.actorUserId,
          allocations: {
            create: resultLines.map((line) => ({
              importShipmentLineId: line.importShipmentLineId,
              amount: line.amount,
            })),
          },
        },
        select: IMPORT_EXPENSE_ALLOCATION_BATCH_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'IMPORT_OPERATIONS',
        action: AuditAction.IMPORT_EXPENSE_ALLOCATED,
        entityType: 'ImportExpenseAllocationBatch',
        entityId: created.id,
        description: `Lote de asignación ${created.id} creado para el gasto ${input.importExpenseId}`,
        metadata: {
          importExpenseId: input.importExpenseId,
          batchId: created.id,
          method: input.method,
          lineCount: resultLines.length,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeImportExpenseAllocationBatch(created);
    });
  }

  /** Reutiliza EXACTAMENTE el mismo cálculo que allocate(), sin lock, sin persistir, sin auditar. */
  async previewAllocation(
    input: PreviewImportExpenseAllocationInput,
    requesterRole: RoleName,
  ): Promise<{
    method: ImportExpenseAllocationMethod;
    requestedAmount: string;
    lines: { importShipmentLineId: string; amount: string }[];
  }> {
    assertCanRead(requesterRole);

    const amountToAllocate = parsePositiveDecimal(
      input.amountToAllocate,
      'amountToAllocate',
    );
    const expense = await this.prisma.importExpense.findUnique({
      where: { id: input.importExpenseId },
      select: { id: true, importOperationId: true, status: true },
    });
    if (expense === null) {
      throw new NotFoundException('Gasto de importación no encontrado');
    }

    const lineIds = this.resolveRequestedLineIds(input);
    const lines = await this.fetchEligibleLinesWithoutLock(
      expense.importOperationId,
      lineIds,
    );
    const resultLines = this.computeAllocationLines(
      input.method,
      amountToAllocate,
      lines,
      input.manualAllocations,
    );

    return {
      method: input.method,
      requestedAmount: amountToAllocate.toFixed(2),
      lines: resultLines.map((line) => ({
        importShipmentLineId: line.importShipmentLineId,
        amount: line.amount.toFixed(2),
      })),
    };
  }

  async listAllocationBatches(
    importExpenseId: string,
    requesterRole: RoleName,
  ): Promise<SafeImportExpenseAllocationBatch[]> {
    assertCanRead(requesterRole);

    const expense = await this.prisma.importExpense.findUnique({
      where: { id: importExpenseId },
      select: { id: true },
    });
    if (expense === null) {
      throw new NotFoundException('Gasto de importación no encontrado');
    }

    const rows = await this.prisma.importExpenseAllocationBatch.findMany({
      where: { importExpenseId },
      select: IMPORT_EXPENSE_ALLOCATION_BATCH_SAFE_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toSafeImportExpenseAllocationBatch);
  }

  // ==================================================================
  // Helpers privados
  // ==================================================================

  private resolveRequestedLineIds(input: {
    method: ImportExpenseAllocationMethod;
    shipmentLineIds?: string[];
    manualAllocations?: ManualAllocationLineInput[];
  }): string[] {
    if (input.method === ImportExpenseAllocationMethod.MANUAL) {
      if (
        !Array.isArray(input.manualAllocations) ||
        input.manualAllocations.length === 0
      ) {
        throw new BadRequestException(
          'manualAllocations es obligatorio y no puede estar vacío para method=MANUAL',
        );
      }
      const ids = input.manualAllocations.map((m) => m.importShipmentLineId);
      if (new Set(ids).size !== ids.length) {
        throw new BadRequestException(
          'manualAllocations no puede referenciar la misma línea más de una vez',
        );
      }
      return ids;
    }

    if (
      !Array.isArray(input.shipmentLineIds) ||
      input.shipmentLineIds.length === 0
    ) {
      throw new BadRequestException(
        'shipmentLineIds es obligatorio y no puede estar vacío para este método',
      );
    }
    if (new Set(input.shipmentLineIds).size !== input.shipmentLineIds.length) {
      throw new BadRequestException(
        'shipmentLineIds no puede contener la misma línea más de una vez',
      );
    }
    return input.shipmentLineIds;
  }

  private async lockExpense(
    tx: Prisma.TransactionClient,
    importExpenseId: string,
  ): Promise<LockedExpenseRow> {
    const rows = await tx.$queryRaw<LockedExpenseRow[]>(Prisma.sql`
      SELECT id, import_operation_id AS "importOperationId", status, amount
      FROM import_expenses
      WHERE id = ${importExpenseId}::uuid
      FOR UPDATE
    `);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('Gasto de importación no encontrado');
    }
    return row;
  }

  private async sumActiveBatches(
    tx: Prisma.TransactionClient,
    importExpenseId: string,
  ): Promise<Prisma.Decimal> {
    const batches = await tx.importExpenseAllocationBatch.findMany({
      where: { importExpenseId },
      select: { requestedAmount: true },
    });
    return batches.reduce((sum, b) => sum.plus(b.requestedAmount), ZERO);
  }

  /**
   * Bloquea (`FOR UPDATE`) las líneas de embarque referenciadas y valida
   * que todas pertenezcan a la MISMA ImportOperation que el gasto (nunca
   * cross-operation, CLAUDE.md B2 §3/§8) y que su embarque no esté
   * CANCELLED — protección real de concurrencia: dos asignaciones
   * concurrentes que referencien las mismas líneas se serializan aquí.
   */
  private async lockEligibleLines(
    tx: Prisma.TransactionClient,
    importOperationId: string,
    lineIds: string[],
  ): Promise<LockedShipmentLineForAllocationRow[]> {
    const sortedIds = Array.from(new Set(lineIds)).sort();
    const rows = await tx.$queryRaw<LockedShipmentLineForAllocationRow[]>(
      Prisma.sql`
        SELECT isl.id, isl.planned_quantity AS "plannedQuantity",
               isl.weight_value AS "weightValue", isl.volume_value AS "volumeValue",
               ish.status AS "shipmentStatus", ish.import_operation_id AS "importOperationId"
        FROM import_shipment_lines isl
        JOIN import_shipments ish ON ish.id = isl.import_shipment_id
        WHERE isl.id = ANY(${sortedIds}::uuid[])
        ORDER BY isl.id ASC
        FOR UPDATE OF isl
      `,
    );
    this.assertLinesEligible(rows, sortedIds, importOperationId);
    return rows;
  }

  private async fetchEligibleLinesWithoutLock(
    importOperationId: string,
    lineIds: string[],
  ): Promise<LockedShipmentLineForAllocationRow[]> {
    const sortedIds = Array.from(new Set(lineIds)).sort();
    const rows = await this.prisma.importShipmentLine.findMany({
      where: { id: { in: sortedIds } },
      select: {
        id: true,
        plannedQuantity: true,
        weightValue: true,
        volumeValue: true,
        importShipment: { select: { status: true, importOperationId: true } },
      },
      orderBy: { id: 'asc' },
    });
    const flattened: LockedShipmentLineForAllocationRow[] = rows.map((r) => ({
      id: r.id,
      plannedQuantity: r.plannedQuantity,
      weightValue: r.weightValue,
      volumeValue: r.volumeValue,
      shipmentStatus: r.importShipment.status,
      importOperationId: r.importShipment.importOperationId,
    }));
    this.assertLinesEligible(flattened, sortedIds, importOperationId);
    return flattened;
  }

  private assertLinesEligible(
    rows: LockedShipmentLineForAllocationRow[],
    requestedIds: string[],
    importOperationId: string,
  ): void {
    if (rows.length !== requestedIds.length) {
      throw new BadRequestException(
        'Alguna línea de embarque referenciada no existe',
      );
    }
    for (const row of rows) {
      if (row.importOperationId !== importOperationId) {
        throw new BadRequestException(
          `La línea ${row.id} no pertenece a la misma operación de importación que el gasto`,
        );
      }
      if (row.shipmentStatus === ImportShipmentStatus.CANCELLED) {
        throw new ConflictException(
          `La línea ${row.id} pertenece a un embarque CANCELLED; no es elegible para asignación`,
        );
      }
    }
  }

  /**
   * Calcula las líneas resultantes para CUALQUIERA de los cuatro métodos
   * — ÚNICA función reutilizada tanto por allocate() como por
   * previewAllocation() (CLAUDE.md B2 §7: "reusing the same calculation
   * as persistence"). Nunca abre transacción ni audita: cálculo puro
   * sobre datos ya resueltos.
   */
  private computeAllocationLines(
    method: ImportExpenseAllocationMethod,
    amountToAllocate: Prisma.Decimal,
    lines: LockedShipmentLineForAllocationRow[],
    manualAllocations: ManualAllocationLineInput[] | undefined,
  ): { importShipmentLineId: string; amount: Prisma.Decimal }[] {
    if (method === ImportExpenseAllocationMethod.MANUAL) {
      if (manualAllocations === undefined) {
        throw new InternalServerErrorException(
          'manualAllocations ausente para method=MANUAL; invariante interno roto',
        );
      }
      const parsed = manualAllocations.map((m) => ({
        importShipmentLineId: m.importShipmentLineId,
        amount: parsePositiveDecimal(m.amount, 'manualAllocations.amount'),
      }));
      const sum = parsed.reduce((s, l) => s.plus(l.amount), ZERO);
      if (!sum.equals(amountToAllocate)) {
        throw new BadRequestException(
          'La suma de manualAllocations debe coincidir exactamente con amountToAllocate',
        );
      }
      return parsed;
    }

    const sortedLines = [...lines].sort((a, b) => (a.id < b.id ? -1 : 1));
    const targets = sortedLines.map((line) => {
      const weight = this.resolveWeightForMethod(method, line);
      return { importShipmentLineId: line.id, weight };
    });
    const totalWeight = targets.reduce((s, t) => s.plus(t.weight), ZERO);
    assertValidDistributionBase(totalWeight);

    return computeProportionalAllocation(targets, amountToAllocate);
  }

  private resolveWeightForMethod(
    method: ImportExpenseAllocationMethod,
    line: LockedShipmentLineForAllocationRow,
  ): Prisma.Decimal {
    if (method === ImportExpenseAllocationMethod.QUANTITY) {
      return line.plannedQuantity;
    }
    if (method === ImportExpenseAllocationMethod.WEIGHT) {
      if (line.weightValue === null) {
        throw new BadRequestException(
          `La línea ${line.id} no tiene weightValue registrado; requerido para method=WEIGHT`,
        );
      }
      return line.weightValue;
    }
    if (line.volumeValue === null) {
      throw new BadRequestException(
        `La línea ${line.id} no tiene volumeValue registrado; requerido para method=VOLUME`,
      );
    }
    return line.volumeValue;
  }

  private async assertSupplierExists(
    tx: Prisma.TransactionClient,
    supplierId: string,
  ): Promise<void> {
    const supplier = await tx.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true },
    });
    if (supplier === null) {
      throw new BadRequestException('El proveedor referenciado no existe');
    }
  }

  private async assertInvoiceLineConfirmed(
    tx: Prisma.TransactionClient,
    purchaseInvoiceLineId: string,
  ): Promise<void> {
    const line = await tx.purchaseInvoiceLine.findUnique({
      where: { id: purchaseInvoiceLineId },
      select: { id: true, purchaseInvoice: { select: { status: true } } },
    });
    if (line === null) {
      throw new BadRequestException(
        'La línea de factura de compra referenciada no existe',
      );
    }
    if (line.purchaseInvoice.status !== PurchaseInvoiceStatus.CONFIRMED) {
      throw new ConflictException(
        'La línea de factura de compra referenciada no pertenece a una factura CONFIRMED',
      );
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

function normalizeRequiredDateOnly(value: string, fieldName: string): Date {
  if (!isValidDateOnly(value)) {
    throw new BadRequestException(
      `${fieldName} debe ser una fecha real en formato YYYY-MM-DD`,
    );
  }
  return toPrismaDate(value);
}

function normalizeCurrencyCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(normalized)) {
    throw new BadRequestException(
      'currencyCode debe ser un código ISO 4217 (3 letras)',
    );
  }
  return normalized;
}

function parsePositiveDecimal(raw: string, fieldName: string): Prisma.Decimal {
  let value: Prisma.Decimal;
  try {
    value = new Prisma.Decimal(raw);
  } catch {
    throw new BadRequestException(`${fieldName} no es un decimal válido`);
  }
  if (!value.isFinite() || value.lessThanOrEqualTo(0)) {
    throw new BadRequestException(`${fieldName} debe ser mayor que cero`);
  }
  return value;
}

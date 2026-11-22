import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RoleName, WarehouseStatus } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import {
  WAREHOUSE_SAFE_SELECT,
  toSafeWarehouse,
} from './mappers/warehouse.mapper';
import {
  CreateWarehouseInput,
  ListWarehousesQuery,
  SafeWarehouse,
  UpdateWarehouseInput,
  WarehouseActionInput,
} from './types/warehouse.types';
import {
  DEACTIVATION_BLOCKED_MESSAGE,
  DEFAULT_LOCATION_CODE,
  assertCanManage,
  assertCanRead,
  hasLocationDependencies,
  normalizeOptionalDescription,
  normalizeRequiredName,
  normalizeWarehouseCode,
  resolvePagination,
} from './warehouse.utils';

const WAREHOUSE_NOT_FOUND = 'Almacén no encontrado';

/**
 * Catálogo de almacenes (R2-A1, EXPAND).
 *
 * Nada aquí mueve stock (eso es StockMovementEngine). Reglas de protección del almacén principal (MAIN):
 *  - `code`, `status` e `isDefault` nunca se editan por PATCH; el estado solo
 *    cambia con activate()/deactivate().
 *  - El almacén predeterminado no puede desactivarse (D4: sin cambios con
 *    R2-ACT; desde R2-ACT todo movimiento lleva ubicación, así que MAIN queda
 *    siempre con rastro). No existe endpoint para cambiar el predeterminado.
 *  - Un almacén nunca se elimina (sin DELETE): se desactiva.
 */
@Injectable()
export class WarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(
    query: ListWarehousesQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeWarehouse>> {
    assertCanRead(requesterRole);
    const { page, limit, skip } = resolvePagination(query);

    const where: Prisma.WarehouseWhereInput = {};
    if (query.status !== undefined) {
      where.status = query.status;
    }
    const term = query.search?.trim();
    if (term !== undefined && term.length > 0) {
      where.OR = [
        { code: { contains: term, mode: 'insensitive' } },
        { name: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.warehouse.findMany({
        where,
        select: WAREHOUSE_SAFE_SELECT,
        orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.warehouse.count({ where }),
    ]);

    return {
      data: rows.map(toSafeWarehouse),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findOne(
    warehouseId: string,
    requesterRole: RoleName,
  ): Promise<SafeWarehouse> {
    assertCanRead(requesterRole);
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
      select: WAREHOUSE_SAFE_SELECT,
    });
    if (warehouse === null) {
      throw new NotFoundException(WAREHOUSE_NOT_FOUND);
    }
    return toSafeWarehouse(warehouse);
  }

  /**
   * Crea el almacén (siempre ACTIVE y no predeterminado) y su ubicación
   * técnica DEFAULT en la MISMA transacción: nunca queda un almacén sin
   * DEFAULT (invariante del servicio; la base de datos garantiza además la
   * unicidad y la forma de DEFAULT con CHECK/índices).
   */
  async create(input: CreateWarehouseInput): Promise<SafeWarehouse> {
    assertCanManage(input.requesterRole);
    const code = normalizeWarehouseCode(input.code);
    const name = normalizeRequiredName(input.name);
    const description = normalizeOptionalDescription(input.description);

    // Sin pre-check SELECT: la unicidad real la garantiza el índice único de
    // base de datos + el filtro global (P2002 -> 409), correcto incluso bajo
    // dos POST concurrentes con el mismo código.
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.warehouse.create({
        data: {
          code,
          name,
          description,
          status: WarehouseStatus.ACTIVE,
          isDefault: false,
        },
        select: WAREHOUSE_SAFE_SELECT,
      });
      const defaultLocation = await tx.warehouseLocation.create({
        data: {
          warehouseId: created.id,
          code: DEFAULT_LOCATION_CODE,
          name: 'Ubicación predeterminada',
          status: WarehouseStatus.ACTIVE,
          isDefault: true,
        },
        select: { id: true },
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'WAREHOUSES',
        action: AuditAction.WAREHOUSE_CREATED,
        entityType: 'Warehouse',
        entityId: created.id,
        description: `Almacén ${created.id} creado`,
        metadata: { code, defaultLocationId: defaultLocation.id },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeWarehouse(created);
    });
  }

  async update(input: UpdateWarehouseInput): Promise<SafeWarehouse> {
    assertCanManage(input.requesterRole);
    if (input.name === undefined && input.description === undefined) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.warehouse.findUnique({
        where: { id: input.warehouseId },
        select: { id: true },
      });
      if (existing === null) {
        throw new NotFoundException(WAREHOUSE_NOT_FOUND);
      }

      const data: Prisma.WarehouseUpdateInput = {};
      const updatedFields: string[] = [];
      if (input.name !== undefined) {
        data.name = normalizeRequiredName(input.name);
        updatedFields.push('name');
      }
      if (input.description !== undefined) {
        data.description = normalizeOptionalDescription(input.description);
        updatedFields.push('description');
      }

      const updated = await tx.warehouse.update({
        where: { id: input.warehouseId },
        data,
        select: WAREHOUSE_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'WAREHOUSES',
        action: AuditAction.WAREHOUSE_UPDATED,
        entityType: 'Warehouse',
        entityId: input.warehouseId,
        description: `Almacén ${input.warehouseId} actualizado`,
        metadata: { updatedFields },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeWarehouse(updated);
    });
  }

  async activate(input: WarehouseActionInput): Promise<SafeWarehouse> {
    assertCanManage(input.requesterRole);
    return this.prisma.$transaction(async (tx) => {
      const warehouse = await this.lockWarehouse(tx, input.warehouseId);
      if (warehouse.status === WarehouseStatus.ACTIVE) {
        throw new ConflictException('El almacén ya está activo');
      }
      return this.applyStatus(
        tx,
        input,
        WarehouseStatus.ACTIVE,
        warehouse.status,
        AuditAction.WAREHOUSE_ACTIVATED,
      );
    });
  }

  async deactivate(input: WarehouseActionInput): Promise<SafeWarehouse> {
    assertCanManage(input.requesterRole);
    return this.prisma.$transaction(async (tx) => {
      // FOR UPDATE: serializa contra la creación/activación de ubicaciones de
      // este almacén (que toman FOR SHARE) y contra otra desactivación.
      const warehouse = await this.lockWarehouse(tx, input.warehouseId);
      if (warehouse.status === WarehouseStatus.INACTIVE) {
        throw new ConflictException('El almacén ya está inactivo');
      }
      if (warehouse.isDefault) {
        throw new ConflictException(
          'El almacén principal no puede desactivarse: sus existencias siguen consolidadas y no puede comprobarse que esté vacío',
        );
      }
      const locations = await tx.warehouseLocation.findMany({
        where: { warehouseId: input.warehouseId },
        select: { id: true },
      });
      if (
        await hasLocationDependencies(
          tx,
          locations.map((location) => location.id),
        )
      ) {
        throw new ConflictException(DEACTIVATION_BLOCKED_MESSAGE);
      }
      return this.applyStatus(
        tx,
        input,
        WarehouseStatus.INACTIVE,
        warehouse.status,
        AuditAction.WAREHOUSE_DEACTIVATED,
      );
    });
  }

  private async lockWarehouse(
    tx: Prisma.TransactionClient,
    warehouseId: string,
  ): Promise<{ id: string; status: WarehouseStatus; isDefault: boolean }> {
    const rows = await tx.$queryRaw<
      { id: string; status: WarehouseStatus; is_default: boolean }[]
    >(
      Prisma.sql`SELECT id, status, is_default FROM warehouses WHERE id = ${warehouseId}::uuid FOR UPDATE`,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(WAREHOUSE_NOT_FOUND);
    }
    return { id: row.id, status: row.status, isDefault: row.is_default };
  }

  private async applyStatus(
    tx: Prisma.TransactionClient,
    input: WarehouseActionInput,
    nextStatus: WarehouseStatus,
    previousStatus: WarehouseStatus,
    action: AuditAction,
  ): Promise<SafeWarehouse> {
    const updated = await tx.warehouse.update({
      where: { id: input.warehouseId },
      data: { status: nextStatus },
      select: WAREHOUSE_SAFE_SELECT,
    });
    await this.auditService.record({
      userId: input.actorUserId,
      module: 'WAREHOUSES',
      action,
      entityType: 'Warehouse',
      entityId: input.warehouseId,
      description: `Almacén ${input.warehouseId}: ${previousStatus} -> ${nextStatus}`,
      metadata: { previousStatus },
      ipAddress: input.ipAddress ?? null,
      client: tx,
    });
    return toSafeWarehouse(updated);
  }
}

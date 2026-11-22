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
  LOCATION_SAFE_SELECT,
  toSafeLocation,
} from './mappers/warehouse.mapper';
import {
  CreateLocationInput,
  ListLocationsQuery,
  LocationActionInput,
  SafeWarehouseLocation,
  UpdateLocationInput,
} from './types/warehouse.types';
import {
  DEACTIVATION_BLOCKED_MESSAGE,
  DEFAULT_LOCATION_CODE,
  assertCanManage,
  assertCanRead,
  hasLocationDependencies,
  normalizeLocationCode,
  normalizeOptionalDescription,
  normalizeRequiredName,
  resolvePagination,
} from './warehouse.utils';

const WAREHOUSE_NOT_FOUND = 'Almacén no encontrado';
const LOCATION_NOT_FOUND = 'Ubicación no encontrada';

/**
 * Catálogo de ubicaciones (R2-A1, EXPAND). Toda operación recibe el
 * `warehouseId` de la ruta y exige que la ubicación pertenezca a ESE almacén:
 * una ubicación de otro almacén responde 404, igual que una inexistente, y
 * nunca puede manipularse por la ruta equivocada.
 *
 * INERTE respecto al inventario: no lee ni escribe stock, movimientos ni
 * saldos. La ubicación técnica DEFAULT de cada almacén nunca cambia de
 * código ni se desactiva por separado, y ninguna ubicación se elimina.
 */
@Injectable()
export class WarehouseLocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(
    warehouseId: string,
    query: ListLocationsQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeWarehouseLocation>> {
    assertCanRead(requesterRole);
    const { page, limit, skip } = resolvePagination(query);

    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
      select: { id: true },
    });
    if (warehouse === null) {
      throw new NotFoundException(WAREHOUSE_NOT_FOUND);
    }

    const where: Prisma.WarehouseLocationWhereInput = { warehouseId };
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
      this.prisma.warehouseLocation.findMany({
        where,
        select: LOCATION_SAFE_SELECT,
        orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.warehouseLocation.count({ where }),
    ]);

    return {
      data: rows.map(toSafeLocation),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findOne(
    warehouseId: string,
    locationId: string,
    requesterRole: RoleName,
  ): Promise<SafeWarehouseLocation> {
    assertCanRead(requesterRole);
    const location = await this.prisma.warehouseLocation.findFirst({
      where: { id: locationId, warehouseId },
      select: LOCATION_SAFE_SELECT,
    });
    if (location === null) {
      throw new NotFoundException(LOCATION_NOT_FOUND);
    }
    return toSafeLocation(location);
  }

  async create(input: CreateLocationInput): Promise<SafeWarehouseLocation> {
    assertCanManage(input.requesterRole);
    const code = normalizeLocationCode(input.code);
    if (code === DEFAULT_LOCATION_CODE) {
      throw new ConflictException(
        `El código ${DEFAULT_LOCATION_CODE} está reservado a la ubicación técnica de cada almacén`,
      );
    }
    const name = normalizeRequiredName(input.name);
    const description = normalizeOptionalDescription(input.description);

    return this.prisma.$transaction(async (tx) => {
      const warehouse = await this.lockWarehouseShared(tx, input.warehouseId);
      if (warehouse.status !== WarehouseStatus.ACTIVE) {
        throw new ConflictException(
          'No pueden crearse ubicaciones en un almacén inactivo',
        );
      }

      // La unicidad (almacén, código) la garantiza la base de datos
      // (P2002 -> 409), correcto también bajo concurrencia.
      const created = await tx.warehouseLocation.create({
        data: {
          warehouseId: input.warehouseId,
          code,
          name,
          description,
          status: WarehouseStatus.ACTIVE,
          isDefault: false,
        },
        select: LOCATION_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'WAREHOUSES',
        action: AuditAction.LOCATION_CREATED,
        entityType: 'WarehouseLocation',
        entityId: created.id,
        description: `Ubicación ${created.id} creada`,
        metadata: { warehouseId: input.warehouseId, code },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeLocation(created);
    });
  }

  async update(input: UpdateLocationInput): Promise<SafeWarehouseLocation> {
    assertCanManage(input.requesterRole);
    if (input.name === undefined && input.description === undefined) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.warehouseLocation.findFirst({
        where: { id: input.locationId, warehouseId: input.warehouseId },
        select: { id: true },
      });
      if (existing === null) {
        throw new NotFoundException(LOCATION_NOT_FOUND);
      }

      const data: Prisma.WarehouseLocationUpdateInput = {};
      const updatedFields: string[] = [];
      if (input.name !== undefined) {
        data.name = normalizeRequiredName(input.name);
        updatedFields.push('name');
      }
      if (input.description !== undefined) {
        data.description = normalizeOptionalDescription(input.description);
        updatedFields.push('description');
      }

      const updated = await tx.warehouseLocation.update({
        where: { id: input.locationId },
        data,
        select: LOCATION_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'WAREHOUSES',
        action: AuditAction.LOCATION_UPDATED,
        entityType: 'WarehouseLocation',
        entityId: input.locationId,
        description: `Ubicación ${input.locationId} actualizada`,
        metadata: { warehouseId: input.warehouseId, updatedFields },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeLocation(updated);
    });
  }

  async activate(input: LocationActionInput): Promise<SafeWarehouseLocation> {
    assertCanManage(input.requesterRole);
    return this.prisma.$transaction(async (tx) => {
      const warehouse = await this.lockWarehouseShared(tx, input.warehouseId);
      const location = await this.lockLocation(tx, input);
      if (location.status === WarehouseStatus.ACTIVE) {
        throw new ConflictException('La ubicación ya está activa');
      }
      if (warehouse.status !== WarehouseStatus.ACTIVE) {
        throw new ConflictException(
          'No puede activarse una ubicación de un almacén inactivo',
        );
      }
      return this.applyStatus(
        tx,
        input,
        WarehouseStatus.ACTIVE,
        location.status,
        AuditAction.LOCATION_ACTIVATED,
      );
    });
  }

  async deactivate(input: LocationActionInput): Promise<SafeWarehouseLocation> {
    assertCanManage(input.requesterRole);
    return this.prisma.$transaction(async (tx) => {
      await this.lockWarehouseShared(tx, input.warehouseId);
      const location = await this.lockLocation(tx, input);
      if (location.status === WarehouseStatus.INACTIVE) {
        throw new ConflictException('La ubicación ya está inactiva');
      }
      if (location.isDefault) {
        throw new ConflictException(
          `La ubicación ${DEFAULT_LOCATION_CODE} no puede desactivarse por separado`,
        );
      }
      if (await hasLocationDependencies(tx, [location.id])) {
        throw new ConflictException(DEACTIVATION_BLOCKED_MESSAGE);
      }
      return this.applyStatus(
        tx,
        input,
        WarehouseStatus.INACTIVE,
        location.status,
        AuditAction.LOCATION_DEACTIVATED,
      );
    });
  }

  /**
   * FOR SHARE sobre el almacén: permite crear/activar ubicaciones en
   * paralelo pero serializa contra la desactivación del almacén (FOR UPDATE).
   */
  private async lockWarehouseShared(
    tx: Prisma.TransactionClient,
    warehouseId: string,
  ): Promise<{ id: string; status: WarehouseStatus }> {
    const rows = await tx.$queryRaw<{ id: string; status: WarehouseStatus }[]>(
      Prisma.sql`SELECT id, status FROM warehouses WHERE id = ${warehouseId}::uuid FOR SHARE`,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(WAREHOUSE_NOT_FOUND);
    }
    return row;
  }

  /** Bloquea la fila exigiendo que pertenezca al almacén de la ruta. */
  private async lockLocation(
    tx: Prisma.TransactionClient,
    input: LocationActionInput,
  ): Promise<{ id: string; status: WarehouseStatus; isDefault: boolean }> {
    const rows = await tx.$queryRaw<
      { id: string; status: WarehouseStatus; is_default: boolean }[]
    >(
      Prisma.sql`SELECT id, status, is_default FROM warehouse_locations WHERE id = ${input.locationId}::uuid AND warehouse_id = ${input.warehouseId}::uuid FOR UPDATE`,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(LOCATION_NOT_FOUND);
    }
    return { id: row.id, status: row.status, isDefault: row.is_default };
  }

  private async applyStatus(
    tx: Prisma.TransactionClient,
    input: LocationActionInput,
    nextStatus: WarehouseStatus,
    previousStatus: WarehouseStatus,
    action: AuditAction,
  ): Promise<SafeWarehouseLocation> {
    const updated = await tx.warehouseLocation.update({
      where: { id: input.locationId },
      data: { status: nextStatus },
      select: LOCATION_SAFE_SELECT,
    });
    await this.auditService.record({
      userId: input.actorUserId,
      module: 'WAREHOUSES',
      action,
      entityType: 'WarehouseLocation',
      entityId: input.locationId,
      description: `Ubicación ${input.locationId}: ${previousStatus} -> ${nextStatus}`,
      metadata: { warehouseId: input.warehouseId, previousStatus },
      ipAddress: input.ipAddress ?? null,
      client: tx,
    });
    return toSafeLocation(updated);
  }
}

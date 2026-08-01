import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProductStatus, RoleName, UnitStatus } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import { toSafeUnit, UNIT_SAFE_SELECT } from './mappers/unit.mapper';
import { CreateUnitInput } from './types/create-unit.input';
import { ListUnitsQuery } from './types/list-units.query';
import { SafeUnit } from './types/safe-unit';
import { UnitStatusActionInput } from './types/unit-status-action.input';
import { UpdateUnitInput } from './types/update-unit.input';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async createUnit(input: CreateUnitInput): Promise<SafeUnit> {
    const code = normalizeUpper(input.code);
    const name = input.name.trim();
    const abbreviation = normalizeUpper(input.abbreviation);
    const allowDecimal = input.allowDecimal ?? false;

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.unit.create({
        data: {
          code,
          name,
          abbreviation,
          allowDecimal,
          status: UnitStatus.ACTIVE,
        },
        select: UNIT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'UNITS',
        action: AuditAction.UNIT_CREATED,
        entityType: 'Unit',
        entityId: created.id,
        description: `Unidad ${code} creada`,
        metadata: { code, abbreviation, allowDecimal },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeUnit(created);
    });
  }

  async listUnits(
    query: ListUnitsQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeUnit>> {
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

    const where: Prisma.UnitWhereInput = {};
    if (requesterRole === RoleName.SELLER) {
      where.status = UnitStatus.ACTIVE;
    } else if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.allowDecimal !== undefined) {
      where.allowDecimal = query.allowDecimal;
    }
    const term = query.search?.trim();
    if (term !== undefined && term.length > 0) {
      where.OR = [
        { code: { contains: term, mode: 'insensitive' } },
        { name: { contains: term, mode: 'insensitive' } },
        { abbreviation: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.unit.findMany({
        where,
        select: UNIT_SAFE_SELECT,
        orderBy: { code: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.unit.count({ where }),
    ]);

    return {
      data: rows.map(toSafeUnit),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findUnitById(id: string, requesterRole: RoleName): Promise<SafeUnit> {
    const unit = await this.prisma.unit.findUnique({
      where: { id },
      select: UNIT_SAFE_SELECT,
    });
    if (unit === null) {
      throw new NotFoundException('Unidad no encontrada');
    }
    if (
      requesterRole === RoleName.SELLER &&
      unit.status !== UnitStatus.ACTIVE
    ) {
      throw new NotFoundException('Unidad no encontrada');
    }
    return toSafeUnit(unit);
  }

  async updateUnit(input: UpdateUnitInput): Promise<SafeUnit> {
    const hasAnyField =
      input.code !== undefined ||
      input.name !== undefined ||
      input.abbreviation !== undefined ||
      input.allowDecimal !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar: code, name, abbreviation o allowDecimal',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.unit.findUnique({
        where: { id: input.unitId },
        select: { id: true, code: true },
      });
      if (existing === null) {
        throw new NotFoundException('Unidad no encontrada');
      }

      const data: Prisma.UnitUpdateInput = {};
      const updatedFields: string[] = [];

      if (input.code !== undefined) {
        data.code = normalizeUpper(input.code);
        updatedFields.push('code');
      }
      if (input.name !== undefined) {
        data.name = input.name.trim();
        updatedFields.push('name');
      }
      if (input.abbreviation !== undefined) {
        data.abbreviation = normalizeUpper(input.abbreviation);
        updatedFields.push('abbreviation');
      }
      if (input.allowDecimal !== undefined) {
        data.allowDecimal = input.allowDecimal;
        updatedFields.push('allowDecimal');
      }

      const updated = await tx.unit.update({
        where: { id: input.unitId },
        data,
        select: UNIT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'UNITS',
        action: AuditAction.UNIT_UPDATED,
        entityType: 'Unit',
        entityId: input.unitId,
        description: `Unidad ${existing.code} actualizada`,
        metadata: { updatedFields },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeUnit(updated);
    });
  }

  async activateUnit(input: UnitStatusActionInput): Promise<SafeUnit> {
    return this.prisma.$transaction(async (tx) => {
      const unit = await tx.unit.findUnique({
        where: { id: input.unitId },
        select: { id: true, code: true, status: true },
      });
      if (unit === null) {
        throw new NotFoundException('Unidad no encontrada');
      }
      if (unit.status === UnitStatus.ACTIVE) {
        throw new ConflictException('La unidad ya está activa');
      }

      const activated = await tx.unit.update({
        where: { id: input.unitId },
        data: { status: UnitStatus.ACTIVE },
        select: UNIT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'UNITS',
        action: AuditAction.UNIT_ACTIVATED,
        entityType: 'Unit',
        entityId: input.unitId,
        description: `Unidad ${unit.code} activada`,
        metadata: { code: unit.code },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeUnit(activated);
    });
  }

  async deactivateUnit(input: UnitStatusActionInput): Promise<SafeUnit> {
    return this.prisma.$transaction(async (tx) => {
      const unit = await tx.unit.findUnique({
        where: { id: input.unitId },
        select: { id: true, code: true, status: true },
      });
      if (unit === null) {
        throw new NotFoundException('Unidad no encontrada');
      }
      if (unit.status === UnitStatus.INACTIVE) {
        throw new ConflictException('La unidad ya está inactiva');
      }

      const activeProducts = await tx.product.count({
        where: { unitId: input.unitId, status: ProductStatus.ACTIVE },
      });
      if (activeProducts > 0) {
        throw new ConflictException(
          'No es posible desactivar: existen productos activos con esta unidad',
        );
      }

      const deactivated = await tx.unit.update({
        where: { id: input.unitId },
        data: { status: UnitStatus.INACTIVE },
        select: UNIT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'UNITS',
        action: AuditAction.UNIT_DEACTIVATED,
        entityType: 'Unit',
        entityId: input.unitId,
        description: `Unidad ${unit.code} desactivada`,
        metadata: { code: unit.code },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeUnit(deactivated);
    });
  }
}

function normalizeUpper(value: string): string {
  return value.trim().toUpperCase();
}

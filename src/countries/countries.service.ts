import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import {
  BusinessConflictException,
  CodedNotFoundException,
  FieldBadRequestException,
} from '../common/errors/error-contract';
import { PrismaService } from '../database/prisma.service';
import { normalizeCountryCodeInput } from './country.utils';
import { SafeCountry } from './types/safe-country';

const SAFE_SELECT = {
  code: true,
  name: true,
  active: true,
  pendingReview: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CountrySelect;

const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
  RoleName.PURCHASING,
  RoleName.WAREHOUSE,
  RoleName.SELLER,
]);
/** PURCHASING registra países nuevos; editar y activar/desactivar es solo de ADMIN. */
const CREATE_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.PURCHASING,
]);
const MANAGE_ROLES: ReadonlySet<RoleName> = new Set([RoleName.ADMIN]);

function assertRole(
  role: RoleName,
  allowed: ReadonlySet<RoleName>,
  message: string,
): void {
  if (!allowed.has(role)) {
    throw new ForbiddenException(message);
  }
}

interface Actor {
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}

/**
 * Catálogo compartido de países (R4). Los países usados por documentos
 * históricos nunca se eliminan: no existe endpoint de borrado y las FK son
 * Restrict. Desactivar solo impide asignarlos a documentos NUEVOS.
 */
@Injectable()
export class CountriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(
    query: { includeInactive?: boolean; search?: string },
    requesterRole: RoleName,
  ): Promise<SafeCountry[]> {
    assertRole(
      requesterRole,
      READ_ROLES,
      'No tiene permisos para consultar países',
    );
    const search = query.search?.trim();
    return this.prisma.country.findMany({
      where: {
        ...(query.includeInactive === true ? {} : { active: true }),
        ...(search
          ? {
              OR: [
                { code: { contains: search, mode: 'insensitive' } },
                { name: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: SAFE_SELECT,
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    });
  }

  async findOne(code: string, requesterRole: RoleName): Promise<SafeCountry> {
    assertRole(
      requesterRole,
      READ_ROLES,
      'No tiene permisos para consultar países',
    );
    const country = await this.prisma.country.findUnique({
      where: { code: code.trim().toUpperCase() },
      select: SAFE_SELECT,
    });
    if (country === null) {
      throw new CodedNotFoundException(
        'País no encontrado',
        'COUNTRY_NOT_FOUND',
      );
    }
    return country;
  }

  async create(
    input: Actor & { code: string; name: string },
  ): Promise<SafeCountry> {
    assertRole(
      input.requesterRole,
      CREATE_ROLES,
      'No tiene permisos para registrar países',
    );
    const code = normalizeCountryCodeInput(input.code, 'code');
    const name = input.name.trim();
    if (name.length === 0) {
      throw new FieldBadRequestException({
        message: 'name no puede estar en blanco',
        code: 'REQUIRED',
        field: 'name',
        type: 'REQUIRED',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const existingByCode = await tx.country.findUnique({
        where: { code },
        select: { code: true },
      });
      if (existingByCode !== null) {
        throw new BusinessConflictException({
          message: `Ya existe un país con el código ${code}`,
          code: 'COUNTRY_CODE_DUPLICATE',
          field: 'code',
        });
      }
      const sameName = await tx.$queryRaw<{ code: string }[]>(Prisma.sql`
        SELECT code FROM countries WHERE UPPER(BTRIM(name)) = UPPER(BTRIM(${name})) LIMIT 1
      `);
      if (sameName.length > 0) {
        throw new BusinessConflictException({
          message: `Ya existe un país con el nombre ${name} (${sameName[0].code})`,
          code: 'COUNTRY_NAME_DUPLICATE',
          field: 'name',
        });
      }

      // La unicidad real también la garantizan la PK y el índice único
      // funcional: ante una carrera, P2002 -> 409 en el filtro global.
      const created = await tx.country.create({
        data: { code, name, createdByUserId: input.actorUserId },
        select: SAFE_SELECT,
      });
      await this.auditService.record({
        userId: input.actorUserId,
        module: 'COUNTRIES',
        action: AuditAction.COUNTRY_CREATED,
        entityType: 'Country',
        entityId: null,
        description: `País ${code} registrado`,
        metadata: { countryCode: code },
        ipAddress: input.ipAddress,
        client: tx,
      });
      return created;
    });
  }

  async update(
    input: Actor & { code: string; name?: string; pendingReview?: boolean },
  ): Promise<SafeCountry> {
    assertRole(
      input.requesterRole,
      MANAGE_ROLES,
      'Solo ADMIN puede editar países',
    );
    const code = input.code.trim().toUpperCase();
    if (input.name === undefined && input.pendingReview === undefined) {
      throw new FieldBadRequestException({
        message: 'Debe enviar al menos un campo para actualizar',
        code: 'EMPTY_UPDATE',
        field: 'name',
        type: 'REQUIRED',
      });
    }
    if (input.pendingReview === true) {
      throw new FieldBadRequestException({
        message: 'pendingReview solo puede confirmarse (false)',
        code: 'INVALID_PENDING_REVIEW',
        field: 'pendingReview',
        type: 'FORMAT',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.country.findUnique({
        where: { code },
        select: { code: true },
      });
      if (current === null) {
        throw new CodedNotFoundException(
          'País no encontrado',
          'COUNTRY_NOT_FOUND',
        );
      }
      const data: Prisma.CountryUpdateInput = {};
      const updatedFields: string[] = [];
      if (input.name !== undefined) {
        const name = input.name.trim();
        const sameName = await tx.$queryRaw<{ code: string }[]>(Prisma.sql`
          SELECT code FROM countries
          WHERE UPPER(BTRIM(name)) = UPPER(BTRIM(${name})) AND code <> ${code} LIMIT 1
        `);
        if (sameName.length > 0) {
          throw new BusinessConflictException({
            message: `Ya existe un país con el nombre ${name} (${sameName[0].code})`,
            code: 'COUNTRY_NAME_DUPLICATE',
            field: 'name',
          });
        }
        data.name = name;
        updatedFields.push('name');
      }
      if (input.pendingReview === false) {
        data.pendingReview = false;
        updatedFields.push('pendingReview');
      }
      const updated = await tx.country.update({
        where: { code },
        data,
        select: SAFE_SELECT,
      });
      await this.auditService.record({
        userId: input.actorUserId,
        module: 'COUNTRIES',
        action: AuditAction.COUNTRY_UPDATED,
        entityType: 'Country',
        entityId: null,
        description: `País ${code} actualizado`,
        metadata: { countryCode: code, updatedFields },
        ipAddress: input.ipAddress,
        client: tx,
      });
      return updated;
    });
  }

  async setActive(
    input: Actor & { code: string; active: boolean },
  ): Promise<SafeCountry> {
    assertRole(
      input.requesterRole,
      MANAGE_ROLES,
      'Solo ADMIN puede activar o desactivar países',
    );
    const code = input.code.trim().toUpperCase();
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ active: boolean }[]>(Prisma.sql`
        SELECT active FROM countries WHERE code = ${code} FOR UPDATE
      `);
      if (rows.length === 0) {
        throw new CodedNotFoundException(
          'País no encontrado',
          'COUNTRY_NOT_FOUND',
        );
      }
      if (rows[0].active === input.active) {
        throw new BusinessConflictException({
          message: input.active
            ? 'El país ya está activo'
            : 'El país ya está inactivo',
          code: input.active
            ? 'COUNTRY_ALREADY_ACTIVE'
            : 'COUNTRY_ALREADY_INACTIVE',
        });
      }
      const updated = await tx.country.update({
        where: { code },
        data: { active: input.active },
        select: SAFE_SELECT,
      });
      await this.auditService.record({
        userId: input.actorUserId,
        module: 'COUNTRIES',
        action: input.active
          ? AuditAction.COUNTRY_ACTIVATED
          : AuditAction.COUNTRY_DEACTIVATED,
        entityType: 'Country',
        entityId: null,
        description: `País ${code} ${input.active ? 'activado' : 'desactivado'}`,
        metadata: { countryCode: code },
        ipAddress: input.ipAddress,
        client: tx,
      });
      return updated;
    });
  }
}

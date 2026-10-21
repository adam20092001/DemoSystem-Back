import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  RoleName,
  SupplierDocumentType,
  SupplierStatus,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import {
  SUPPLIER_SAFE_SELECT,
  toSafeSupplier,
} from './mappers/supplier.mapper';
import {
  assertValidDocumentFormat,
  normalizeCountryCode,
  normalizeDocumentNumber,
} from './supplier-document.utils';
import { CreateSupplierInput } from './types/create-supplier.input';
import { ListSuppliersQuery } from './types/list-suppliers.query';
import { SafeSupplier } from './types/safe-supplier';
import { SupplierActionInput } from './types/supplier-action.input';
import { UpdateSupplierInput } from './types/update-supplier.input';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Alcance de lectura (A5.1 kickoff, §6): ADMIN/MANAGEMENT/ACCOUNTANT leen;
 * SELLER/WAREHOUSE sin ningún acceso nuevo. `default` también falla cerrado
 * (mismo criterio que CustomersService.visibleStatusesForRole()).
 */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
]);

function assertCanRead(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar proveedores',
    );
  }
}

interface NormalizedDocument {
  documentType: SupplierDocumentType;
  documentNumber: string;
}

@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(input: CreateSupplierInput): Promise<SafeSupplier> {
    const document = this.normalizeDocument(
      input.documentType,
      input.documentNumber,
    );
    const countryCode = normalizeCountryCode(input.countryCode);
    const legalName = normalizeRequiredText(input.legalName, 'legalName');
    const tradeName = normalizeOptionalText(input.tradeName);
    const contactName = normalizeOptionalText(input.contactName);
    const phone = normalizeOptionalText(input.phone);
    const email = normalizeEmail(input.email);
    const address = normalizeOptionalText(input.address);
    const internalNotes = normalizeOptionalText(input.internalNotes);
    const defaultCurrencyCode = normalizeCurrencyCode(
      input.defaultCurrencyCode,
    );

    return this.prisma.$transaction(async (tx) => {
      // Sin pre-check SELECT: la unicidad real la garantiza el índice único
      // funcional de la migración (suppliers_document_unique) + el filtro
      // global de excepciones (P2002 -> 409) — mismo criterio exacto que
      // CustomersService.create(), que tampoco hace un SELECT previo. Un
      // pre-check aquí sería una condición de carrera (TOCTOU) sin valor
      // real: la única fuente de verdad sigue siendo la restricción de base
      // de datos.
      const created = await tx.supplier.create({
        data: {
          documentType: document.documentType,
          documentNumber: document.documentNumber,
          countryCode,
          legalName,
          tradeName,
          contactName,
          phone,
          email,
          address,
          internalNotes,
          defaultCurrencyCode,
          status: SupplierStatus.ACTIVE,
        },
        select: SUPPLIER_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'SUPPLIERS',
        action: AuditAction.SUPPLIER_CREATED,
        entityType: 'Supplier',
        entityId: created.id,
        description: `Proveedor ${created.id} creado`,
        metadata: {
          documentType: document.documentType,
          countryCode,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeSupplier(created);
    });
  }

  async list(
    query: ListSuppliersQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeSupplier>> {
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
      // Rol sin ningún acceso: página vacía sin tocar Prisma. Defensa en
      // profundidad; el controller igualmente rechaza esto con 403.
      return { data: [], page, limit, total: 0, totalPages: 0 };
    }

    const where: Prisma.SupplierWhereInput = {};
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.documentType !== undefined) {
      where.documentType = query.documentType;
    }
    if (query.countryCode !== undefined) {
      where.countryCode = query.countryCode.trim().toUpperCase();
    }
    const term = query.search?.trim();
    if (term !== undefined && term.length > 0) {
      where.OR = [
        { documentNumber: { contains: term, mode: 'insensitive' } },
        { legalName: { contains: term, mode: 'insensitive' } },
        { tradeName: { contains: term, mode: 'insensitive' } },
        { contactName: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        select: SUPPLIER_SAFE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.supplier.count({ where }),
    ]);

    return {
      data: rows.map(toSafeSupplier),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findOne(
    supplierId: string,
    requesterRole: RoleName,
  ): Promise<SafeSupplier> {
    assertCanRead(requesterRole);
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
      select: SUPPLIER_SAFE_SELECT,
    });
    if (supplier === null) {
      throw new NotFoundException('Proveedor no encontrado');
    }
    return toSafeSupplier(supplier);
  }

  async update(input: UpdateSupplierInput): Promise<SafeSupplier> {
    const documentTypeProvided = input.documentType !== undefined;
    const documentNumberProvided = input.documentNumber !== undefined;
    if (documentTypeProvided !== documentNumberProvided) {
      throw new BadRequestException(
        'documentType y documentNumber deben proveerse juntos',
      );
    }

    const hasAnyField =
      input.legalName !== undefined ||
      input.tradeName !== undefined ||
      input.contactName !== undefined ||
      input.phone !== undefined ||
      input.email !== undefined ||
      input.address !== undefined ||
      input.internalNotes !== undefined ||
      input.defaultCurrencyCode !== undefined ||
      input.countryCode !== undefined ||
      documentTypeProvided;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.supplier.findUnique({
        where: { id: input.supplierId },
        select: { id: true },
      });
      if (existing === null) {
        throw new NotFoundException('Proveedor no encontrado');
      }

      const data: Prisma.SupplierUpdateInput = {};
      const updatedFields: string[] = [];

      if (
        input.documentType !== undefined &&
        input.documentNumber !== undefined
      ) {
        const document = this.normalizeDocument(
          input.documentType,
          input.documentNumber,
        );
        data.documentType = document.documentType;
        data.documentNumber = document.documentNumber;
        updatedFields.push('documentType', 'documentNumber');
      }
      if (input.countryCode !== undefined) {
        data.countryCode = normalizeCountryCode(input.countryCode);
        updatedFields.push('countryCode');
      }
      if (input.legalName !== undefined) {
        data.legalName = normalizeRequiredText(input.legalName, 'legalName');
        updatedFields.push('legalName');
      }
      if (input.tradeName !== undefined) {
        data.tradeName = normalizeOptionalText(input.tradeName);
        updatedFields.push('tradeName');
      }
      if (input.contactName !== undefined) {
        data.contactName = normalizeOptionalText(input.contactName);
        updatedFields.push('contactName');
      }
      if (input.phone !== undefined) {
        data.phone = normalizeOptionalText(input.phone);
        updatedFields.push('phone');
      }
      if (input.email !== undefined) {
        data.email = normalizeEmail(input.email);
        updatedFields.push('email');
      }
      if (input.address !== undefined) {
        data.address = normalizeOptionalText(input.address);
        updatedFields.push('address');
      }
      if (input.internalNotes !== undefined) {
        data.internalNotes = normalizeOptionalText(input.internalNotes);
        updatedFields.push('internalNotes');
      }
      if (input.defaultCurrencyCode !== undefined) {
        data.defaultCurrencyCode = normalizeCurrencyCode(
          input.defaultCurrencyCode,
        );
        updatedFields.push('defaultCurrencyCode');
      }

      const updated = await tx.supplier.update({
        where: { id: input.supplierId },
        data,
        select: SUPPLIER_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'SUPPLIERS',
        action: AuditAction.SUPPLIER_UPDATED,
        entityType: 'Supplier',
        entityId: input.supplierId,
        description: `Proveedor ${input.supplierId} actualizado`,
        metadata: { updatedFields },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeSupplier(updated);
    });
  }

  async activate(input: SupplierActionInput): Promise<SafeSupplier> {
    return this.applyStatusTransition(
      input,
      SupplierStatus.INACTIVE,
      SupplierStatus.ACTIVE,
      AuditAction.SUPPLIER_ACTIVATED,
      'El proveedor ya está activo',
    );
  }

  async deactivate(input: SupplierActionInput): Promise<SafeSupplier> {
    return this.applyStatusTransition(
      input,
      SupplierStatus.ACTIVE,
      SupplierStatus.INACTIVE,
      AuditAction.SUPPLIER_DEACTIVATED,
      'El proveedor ya está inactivo',
    );
  }

  private async applyStatusTransition(
    input: SupplierActionInput,
    requiredCurrentStatus: SupplierStatus,
    nextStatus: SupplierStatus,
    action: AuditAction,
    conflictMessage: string,
  ): Promise<SafeSupplier> {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUnique({
        where: { id: input.supplierId },
        select: { id: true, status: true },
      });
      if (supplier === null) {
        throw new NotFoundException('Proveedor no encontrado');
      }
      if (supplier.status !== requiredCurrentStatus) {
        throw new ConflictException(conflictMessage);
      }

      const previousStatus = supplier.status;
      const updated = await tx.supplier.update({
        where: { id: input.supplierId },
        data: { status: nextStatus },
        select: SUPPLIER_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'SUPPLIERS',
        action,
        entityType: 'Supplier',
        entityId: input.supplierId,
        description: `Proveedor ${input.supplierId} cambia de estado`,
        metadata: { previousStatus },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeSupplier(updated);
    });
  }

  private normalizeDocument(
    documentType: SupplierDocumentType,
    documentNumber: string,
  ): NormalizedDocument {
    const normalizedNumber = normalizeDocumentNumber(documentNumber);
    assertValidDocumentFormat(documentType, normalizedNumber);
    return { documentType, documentNumber: normalizedNumber };
  }
}

function normalizeRequiredText(value: string, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${fieldName} debe ser un texto`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BadRequestException(`${fieldName} no puede estar vacío`);
  }
  return trimmed;
}

function normalizeOptionalText(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCurrencyCode(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

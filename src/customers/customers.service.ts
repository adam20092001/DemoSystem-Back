import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomerDocumentType,
  CustomerStage,
  CustomerStatus,
  Prisma,
  RoleName,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import {
  CUSTOMER_SAFE_SELECT,
  toSafeCustomer,
} from './mappers/customer.mapper';
import { CreateCustomerInput } from './types/create-customer.input';
import { CustomerActionInput } from './types/customer-action.input';
import { ListCustomersQuery } from './types/list-customers.query';
import { SafeCustomer } from './types/safe-customer';
import { UpdateCustomerInput } from './types/update-customer.input';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Estados visibles por rol (defensa en profundidad; Bloque C decide el
 * acceso HTTP real vía guards). SELLER nunca ve INACTIVE. WAREHOUSE no
 * tiene ningún acceso a Customer: un arreglo vacío, no la visibilidad de
 * SELLER ni la de ningún otro rol. `default` también devuelve vacío
 * (fail-closed): un rol futuro/desconocido nunca hereda visibilidad por
 * omisión.
 */
function visibleStatusesForRole(role: RoleName): CustomerStatus[] {
  switch (role) {
    case RoleName.ADMIN:
    case RoleName.MANAGEMENT:
      return [
        CustomerStatus.ACTIVE,
        CustomerStatus.INACTIVE,
        CustomerStatus.BLOCKED,
      ];
    case RoleName.SELLER:
      return [CustomerStatus.ACTIVE, CustomerStatus.BLOCKED];
    case RoleName.WAREHOUSE:
      return [];
    default:
      return [];
  }
}

interface NormalizedDocumentPair {
  documentType: CustomerDocumentType | null;
  documentNumber: string | null;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(input: CreateCustomerInput): Promise<SafeCustomer> {
    const name = normalizeRequiredName(input.name);
    const document = this.normalizeDocumentPairForCreate(
      input.documentType,
      input.documentNumber,
    );
    const tradeName = normalizeOptionalText(input.tradeName);
    const contactName = normalizeOptionalText(input.contactName);
    const email = normalizeEmail(input.email);
    const phone = normalizeOptionalText(input.phone);
    const address = normalizeOptionalText(input.address);
    const internalNotes = normalizeOptionalText(input.internalNotes);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.customer.create({
        data: {
          customerType: input.customerType,
          customerStage: input.customerStage,
          documentType: document.documentType,
          documentNumber: document.documentNumber,
          name,
          tradeName,
          contactName,
          email,
          phone,
          address,
          internalNotes,
          isGeneric: false,
          status: CustomerStatus.ACTIVE,
        },
        select: CUSTOMER_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'CUSTOMERS',
        action: AuditAction.CUSTOMER_CREATED,
        entityType: 'Customer',
        entityId: created.id,
        description: `Cliente ${created.id} creado`,
        metadata: {
          customerType: input.customerType,
          customerStage: input.customerStage,
          documentType: document.documentType,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeCustomer(created);
    });
  }

  async list(
    query: ListCustomersQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeCustomer>> {
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

    const visibleStatuses = visibleStatusesForRole(requesterRole);
    if (visibleStatuses.length === 0) {
      // Rol sin ningún acceso a Customer (WAREHOUSE u otro no contemplado):
      // página vacía sin tocar Prisma. Defensa en profundidad; el Bloque C
      // igualmente rechaza esto con 403 en la capa HTTP.
      return { data: [], page, limit, total: 0, totalPages: 0 };
    }
    if (query.status !== undefined && !visibleStatuses.includes(query.status)) {
      // El rol filtró explícitamente un estado que no le corresponde ver
      // (p. ej. SELLER pidiendo INACTIVE): página vacía, nunca 403 ni fuga
      // de existencia.
      return { data: [], page, limit, total: 0, totalPages: 0 };
    }

    const where: Prisma.CustomerWhereInput = {
      status: query.status ?? { in: visibleStatuses },
    };
    if (query.customerType !== undefined) {
      where.customerType = query.customerType;
    }
    if (query.customerStage !== undefined) {
      where.customerStage = query.customerStage;
    }
    if (query.documentType !== undefined) {
      where.documentType = query.documentType;
    }
    if (query.isGeneric !== undefined) {
      where.isGeneric = query.isGeneric;
    }
    const term = query.search?.trim();
    if (term !== undefined && term.length > 0) {
      where.OR = [
        { documentNumber: { contains: term, mode: 'insensitive' } },
        { name: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
        { tradeName: { contains: term, mode: 'insensitive' } },
        { contactName: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        select: CUSTOMER_SAFE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.customer.count({ where }),
    ]);

    return {
      data: rows.map(toSafeCustomer),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findOne(
    customerId: string,
    requesterRole: RoleName,
  ): Promise<SafeCustomer> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: CUSTOMER_SAFE_SELECT,
    });
    if (customer === null) {
      throw new NotFoundException('Cliente no encontrado');
    }
    if (!visibleStatusesForRole(requesterRole).includes(customer.status)) {
      throw new NotFoundException('Cliente no encontrado');
    }
    return toSafeCustomer(customer);
  }

  async update(input: UpdateCustomerInput): Promise<SafeCustomer> {
    const documentTypeProvided = input.documentType !== undefined;
    const documentNumberProvided = input.documentNumber !== undefined;
    if (documentTypeProvided !== documentNumberProvided) {
      throw new BadRequestException(
        'documentType y documentNumber deben proveerse juntos: ambos con valor o ambos null',
      );
    }

    const hasAnyField =
      input.name !== undefined ||
      input.tradeName !== undefined ||
      input.contactName !== undefined ||
      input.email !== undefined ||
      input.phone !== undefined ||
      input.address !== undefined ||
      input.internalNotes !== undefined ||
      documentTypeProvided;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findUnique({
        where: { id: input.customerId },
        select: { id: true, isGeneric: true },
      });
      if (existing === null) {
        throw new NotFoundException('Cliente no encontrado');
      }
      if (existing.isGeneric) {
        throw new ConflictException(
          'El cliente genérico "Público general" no puede modificarse',
        );
      }

      const data: Prisma.CustomerUpdateInput = {};
      const updatedFields: string[] = [];

      if (input.name !== undefined) {
        data.name = normalizeRequiredName(input.name);
        updatedFields.push('name');
      }
      if (input.tradeName !== undefined) {
        data.tradeName = normalizeOptionalText(input.tradeName);
        updatedFields.push('tradeName');
      }
      if (input.contactName !== undefined) {
        data.contactName = normalizeOptionalText(input.contactName);
        updatedFields.push('contactName');
      }
      if (input.email !== undefined) {
        data.email = normalizeEmail(input.email);
        updatedFields.push('email');
      }
      if (input.phone !== undefined) {
        data.phone = normalizeOptionalText(input.phone);
        updatedFields.push('phone');
      }
      if (input.address !== undefined) {
        data.address = normalizeOptionalText(input.address);
        updatedFields.push('address');
      }
      if (input.internalNotes !== undefined) {
        data.internalNotes = normalizeOptionalText(input.internalNotes);
        updatedFields.push('internalNotes');
      }
      if (documentTypeProvided && documentNumberProvided) {
        const document = this.normalizeDocumentPairForUpdate(
          input.documentType ?? null,
          input.documentNumber ?? null,
        );
        data.documentType = document.documentType;
        data.documentNumber = document.documentNumber;
        updatedFields.push('documentType', 'documentNumber');
      }

      const updated = await tx.customer.update({
        where: { id: input.customerId },
        data,
        select: CUSTOMER_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'CUSTOMERS',
        action: AuditAction.CUSTOMER_UPDATED,
        entityType: 'Customer',
        entityId: input.customerId,
        description: `Cliente ${input.customerId} actualizado`,
        metadata: { updatedFields },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeCustomer(updated);
    });
  }

  async activate(input: CustomerActionInput): Promise<SafeCustomer> {
    return this.applyStatusTransition(
      input,
      CustomerStatus.INACTIVE,
      CustomerStatus.ACTIVE,
      AuditAction.CUSTOMER_ACTIVATED,
      'El cliente ya está activo',
    );
  }

  async deactivate(input: CustomerActionInput): Promise<SafeCustomer> {
    return this.applyStatusTransition(
      input,
      CustomerStatus.ACTIVE,
      CustomerStatus.INACTIVE,
      AuditAction.CUSTOMER_DEACTIVATED,
      'El cliente ya está inactivo',
    );
  }

  async block(input: CustomerActionInput): Promise<SafeCustomer> {
    return this.applyStatusTransition(
      input,
      CustomerStatus.ACTIVE,
      CustomerStatus.BLOCKED,
      AuditAction.CUSTOMER_BLOCKED,
      'El cliente ya está bloqueado',
    );
  }

  async unblock(input: CustomerActionInput): Promise<SafeCustomer> {
    return this.applyStatusTransition(
      input,
      CustomerStatus.BLOCKED,
      CustomerStatus.ACTIVE,
      AuditAction.CUSTOMER_UNBLOCKED,
      'El cliente ya está activo',
    );
  }

  async convertToCustomer(input: CustomerActionInput): Promise<SafeCustomer> {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id: input.customerId },
        select: { id: true, customerStage: true, isGeneric: true },
      });
      if (customer === null) {
        throw new NotFoundException('Cliente no encontrado');
      }
      if (customer.isGeneric) {
        throw new ConflictException(
          'El cliente genérico "Público general" no puede cambiar de etapa',
        );
      }
      if (customer.customerStage !== CustomerStage.PROSPECT) {
        throw new ConflictException(
          'Solo un prospecto puede convertirse en cliente',
        );
      }

      const previousStage = customer.customerStage;
      const updated = await tx.customer.update({
        where: { id: input.customerId },
        data: { customerStage: CustomerStage.CUSTOMER },
        select: CUSTOMER_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'CUSTOMERS',
        action: AuditAction.CUSTOMER_STAGE_CHANGED,
        entityType: 'Customer',
        entityId: input.customerId,
        description: `Cliente ${input.customerId} convertido de prospecto a cliente`,
        metadata: { previousStage, customerStage: CustomerStage.CUSTOMER },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeCustomer(updated);
    });
  }

  private async applyStatusTransition(
    input: CustomerActionInput,
    requiredCurrentStatus: CustomerStatus,
    nextStatus: CustomerStatus,
    action: AuditAction,
    conflictMessage: string,
  ): Promise<SafeCustomer> {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id: input.customerId },
        select: { id: true, status: true, isGeneric: true },
      });
      if (customer === null) {
        throw new NotFoundException('Cliente no encontrado');
      }
      if (customer.isGeneric) {
        throw new ConflictException(
          'El cliente genérico "Público general" no puede cambiar de estado',
        );
      }
      if (customer.status !== requiredCurrentStatus) {
        throw new ConflictException(conflictMessage);
      }

      const previousStatus = customer.status;
      const updated = await tx.customer.update({
        where: { id: input.customerId },
        data: { status: nextStatus },
        select: CUSTOMER_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'CUSTOMERS',
        action,
        entityType: 'Customer',
        entityId: input.customerId,
        description: `Cliente ${input.customerId} cambia de estado`,
        metadata: { previousStatus },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeCustomer(updated);
    });
  }

  private normalizeDocumentPairForCreate(
    documentType: CustomerDocumentType | undefined,
    documentNumber: string | undefined,
  ): NormalizedDocumentPair {
    const hasType = documentType !== undefined;
    const hasNumber = documentNumber !== undefined;
    if (hasType !== hasNumber) {
      throw new BadRequestException(
        'documentType y documentNumber deben proveerse juntos',
      );
    }
    if (!hasType) {
      return { documentType: null, documentNumber: null };
    }
    return this.normalizeDocumentPairForUpdate(
      documentType ?? null,
      documentNumber ?? null,
    );
  }

  /** Ambos null limpia el par; ambos con valor lo reemplaza normalizado. */
  private normalizeDocumentPairForUpdate(
    documentType: CustomerDocumentType | null,
    documentNumber: string | null,
  ): NormalizedDocumentPair {
    if (documentType === null && documentNumber === null) {
      return { documentType: null, documentNumber: null };
    }
    if (documentType === null || documentNumber === null) {
      throw new BadRequestException(
        'documentType y documentNumber deben proveerse juntos: ambos con valor o ambos null',
      );
    }
    const normalizedNumber = documentNumber.trim().toUpperCase();
    if (normalizedNumber.length === 0) {
      throw new BadRequestException('documentNumber no puede estar vacío');
    }
    return { documentType, documentNumber: normalizedNumber };
  }
}

function normalizeRequiredName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BadRequestException('El nombre del cliente no puede estar vacío');
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

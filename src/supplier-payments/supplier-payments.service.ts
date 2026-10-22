import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountingSourceType,
  Prisma,
  PurchaseInvoiceStatus,
  RoleName,
  SupplierPaymentStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AccountingEngine } from '../accounting/accounting.engine';
import { buildSupplierPaymentOriginalDescription } from '../accounting/accounting-calculator';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import {
  businessToday,
  isValidDateOnly,
  toPrismaDate,
} from '../common/date/business-date';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import { SettingsReader } from '../configuration/settings-reader.service';
import { PaymentMethodReader } from '../payment-methods/payment-method-reader.service';
import { MAX_SUPPLIER_PAYMENT_ALLOCATIONS } from './constants/supplier-payment.constants';
import {
  SUPPLIER_PAYMENT_SAFE_SELECT,
  toSafeSupplierPayment,
} from './mappers/supplier-payment.mapper';
import {
  assertReferenceRequiredForSupplierPaymentMethod,
  groupLiabilityAmountsByAccount,
  normalizeSupplierPaymentMethodCode,
  normalizeSupplierPaymentReference,
  parseSupplierPaymentAmount,
} from './supplier-payment-calculator';
import { CancelSupplierPaymentInput } from './types/cancel-supplier-payment.input';
import { CreateSupplierPaymentInput } from './types/create-supplier-payment.input';
import { ListSupplierPaymentsQuery } from './types/list-supplier-payments.query';
import { SafeSupplierPayment } from './types/safe-supplier-payment';

const ZERO = new Prisma.Decimal(0);

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** ADMIN administra el ciclo de vida completo; MANAGEMENT/ACCOUNTANT solo leen. SELLER/WAREHOUSE sin ningún acceso (A5.3). */
const MANAGE_ROLES: ReadonlySet<RoleName> = new Set([RoleName.ADMIN]);
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
]);

function assertCanRead(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar pagos a proveedores',
    );
  }
}

function assertCanManage(requesterRole: RoleName): void {
  if (!MANAGE_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para administrar pagos a proveedores',
    );
  }
}

interface LockedInvoiceRow {
  id: string;
  supplierId: string;
  status: PurchaseInvoiceStatus;
  currencyCode: string;
  totalAmount: Prisma.Decimal;
  postedEntryId: string | null;
}

/**
 * Pagos a proveedores y su contabilización (Fase A5.3). Nunca escribe
 * AccountingEntry/AccountingEntryLine directamente: siempre delega en
 * AccountingEngine, el único escritor de ese dominio. El saldo pendiente de
 * cada PurchaseInvoice NUNCA se lee de una columna duplicada — siempre se
 * recalcula fresco, bajo el lock de la factura, a partir de
 * SupplierPaymentAllocation de pagos ACTIVE (ver AccountsPayableService
 * para el mismo cálculo en modo solo lectura, sin transacción).
 */
@Injectable()
export class SupplierPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly accountingEngine: AccountingEngine,
    private readonly settingsReader: SettingsReader,
    private readonly paymentMethodReader: PaymentMethodReader,
  ) {}

  // ==================================================================
  // Lectura
  // ==================================================================

  async findOne(
    supplierPaymentId: string,
    requesterRole: RoleName,
  ): Promise<SafeSupplierPayment> {
    assertCanRead(requesterRole);
    const row = await this.prisma.supplierPayment.findUnique({
      where: { id: supplierPaymentId },
      select: SUPPLIER_PAYMENT_SAFE_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('Pago a proveedor no encontrado');
    }
    return toSafeSupplierPayment(row);
  }

  async list(
    query: ListSupplierPaymentsQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeSupplierPayment>> {
    assertCanRead(requesterRole);

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

    const where: Prisma.SupplierPaymentWhereInput = {};
    if (query.supplierId !== undefined) {
      where.supplierId = query.supplierId;
    }
    if (query.status !== undefined) {
      where.status = query.status;
    }

    const [rows, total] = await Promise.all([
      this.prisma.supplierPayment.findMany({
        where,
        select: SUPPLIER_PAYMENT_SAFE_SELECT,
        orderBy: [{ paymentDate: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.supplierPayment.count({ where }),
    ]);

    return {
      data: rows.map(toSafeSupplierPayment),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  // ==================================================================
  // Registro
  // ==================================================================

  async create(
    input: CreateSupplierPaymentInput,
  ): Promise<SafeSupplierPayment> {
    assertCanManage(input.requesterRole);

    const amount = parseSupplierPaymentAmount(input.amount);
    const paymentDateString = input.paymentDate ?? businessToday();
    const paymentDate = this.normalizeDateOnly(
      paymentDateString,
      'paymentDate',
    );
    const reference = normalizeSupplierPaymentReference(input.reference);
    const idempotencyKey = this.normalizeIdempotencyKey(input.idempotencyKey);
    const normalizedMethodCode = normalizeSupplierPaymentMethodCode(
      input.method,
    );

    if (input.allocations.length === 0) {
      throw new BadRequestException(
        'Debe incluir al menos una asignación en el pago',
      );
    }
    if (input.allocations.length > MAX_SUPPLIER_PAYMENT_ALLOCATIONS) {
      throw new BadRequestException(
        `El pago admite como máximo ${MAX_SUPPLIER_PAYMENT_ALLOCATIONS} asignaciones`,
      );
    }
    const allocations = this.normalizeAllocations(input.allocations);
    const allocationSum = Array.from(allocations.values()).reduce(
      (sum, value) => sum.plus(value),
      ZERO,
    );
    if (!allocationSum.equals(amount)) {
      throw new BadRequestException(
        'La suma de allocations debe ser exactamente igual a amount',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUnique({
        where: { id: input.supplierId },
        select: { id: true, legalName: true },
      });
      if (supplier === null) {
        throw new BadRequestException('El proveedor indicado no existe');
      }

      if (idempotencyKey !== null) {
        const existing = await tx.supplierPayment.findUnique({
          where: {
            supplierId_idempotencyKey: {
              supplierId: input.supplierId,
              idempotencyKey,
            },
          },
          select: SUPPLIER_PAYMENT_SAFE_SELECT,
        });
        if (existing !== null) {
          // Reintento idempotente real: mismo resultado, sin duplicar
          // ningún efecto (asignaciones/auditoría/contabilidad).
          return toSafeSupplierPayment(existing);
        }
      }

      const invoiceIds = Array.from(allocations.keys()).sort();
      const lockedInvoices = await tx.$queryRaw<LockedInvoiceRow[]>(Prisma.sql`
        SELECT id, supplier_id AS "supplierId", status,
               currency_code AS "currencyCode", total_amount AS "totalAmount",
               posted_entry_id AS "postedEntryId"
        FROM purchase_invoices
        WHERE id = ANY(${invoiceIds}::uuid[])
        ORDER BY id ASC
        FOR UPDATE
      `);
      if (lockedInvoices.length !== invoiceIds.length) {
        throw new BadRequestException(
          'Alguna factura de compra referenciada no existe',
        );
      }
      for (const row of lockedInvoices) {
        if (row.supplierId !== input.supplierId) {
          throw new BadRequestException(
            `La factura ${row.id} no pertenece al proveedor indicado`,
          );
        }
        if (row.status !== PurchaseInvoiceStatus.CONFIRMED) {
          throw new ConflictException(`La factura ${row.id} no está CONFIRMED`);
        }
        if (row.postedEntryId === null) {
          throw new InternalServerErrorException(
            'Factura CONFIRMED sin asiento contable asociado; invariante interno roto',
          );
        }
      }

      // A0.2 (mismo criterio exacto que SalesService.createDirect()/
      // PurchaseInvoicesService.create()): bloquea la fila singleton de
      // configuración antes de fijar la moneda del pago, para que un
      // cambio de moneda concurrente nunca produzca un estado mixto.
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM company_settings WHERE singleton = true FOR UPDATE`,
      );
      const settings = await this.settingsReader.getCurrent(tx);
      for (const row of lockedInvoices) {
        if (row.currencyCode !== settings.currencyCode) {
          throw new ConflictException(
            `La factura ${row.id} está en una moneda distinta a la vigente de la empresa`,
          );
        }
      }

      const paidSums = await tx.supplierPaymentAllocation.groupBy({
        by: ['purchaseInvoiceId'],
        where: {
          purchaseInvoiceId: { in: invoiceIds },
          supplierPayment: { status: SupplierPaymentStatus.ACTIVE },
        },
        _sum: { amount: true },
      });
      const paidMap = new Map(
        paidSums.map((row) => [row.purchaseInvoiceId, row._sum.amount ?? ZERO]),
      );

      for (const row of lockedInvoices) {
        const alreadyPaid = paidMap.get(row.id) ?? ZERO;
        const allocationAmount = allocations.get(row.id);
        if (allocationAmount === undefined) {
          throw new InternalServerErrorException(
            'Factura bloqueada sin monto asignado; invariante interno roto',
          );
        }
        const pending = row.totalAmount.minus(alreadyPaid);
        if (allocationAmount.greaterThan(pending)) {
          throw new ConflictException(
            `El monto asignado a la factura ${row.id} supera su saldo pendiente`,
          );
        }
      }

      const method = await this.paymentMethodReader.findByCode(
        normalizedMethodCode,
        tx,
      );
      if (method === null) {
        throw new NotFoundException(
          `No existe un método de pago con code "${normalizedMethodCode}"`,
        );
      }
      if (!method.active) {
        throw new ConflictException(
          `El método de pago "${normalizedMethodCode}" está inactivo`,
        );
      }
      assertReferenceRequiredForSupplierPaymentMethod(
        method.requiresReference,
        reference,
      );

      // Cuenta de pasivo HISTÓRICA: la que el asiento PURCHASE original de
      // cada factura REALMENTE acreditó, nunca el mapeo VIGENTE de
      // ACCOUNTS_PAYABLE (podría haberse reasignado desde la confirmación).
      const postedEntryIds = lockedInvoices.map((row) => {
        if (row.postedEntryId === null) {
          throw new InternalServerErrorException(
            'Factura CONFIRMED sin asiento contable asociado; invariante interno roto',
          );
        }
        return row.postedEntryId;
      });
      const creditLines = await tx.accountingEntryLine.findMany({
        where: { entryId: { in: postedEntryIds }, creditAmount: { gt: 0 } },
        select: { entryId: true, accountId: true },
      });
      const creditAccountIdsByEntryId = new Map<string, string[]>();
      for (const line of creditLines) {
        const existing = creditAccountIdsByEntryId.get(line.entryId) ?? [];
        existing.push(line.accountId);
        creditAccountIdsByEntryId.set(line.entryId, existing);
      }

      const liabilityPlanItems = lockedInvoices.map((row) => {
        const entryId = row.postedEntryId as string;
        const creditAccountIds = creditAccountIdsByEntryId.get(entryId) ?? [];
        if (creditAccountIds.length !== 1) {
          throw new InternalServerErrorException(
            `El asiento original de la factura ${row.id} no tiene exactamente una línea de crédito de pasivo; invariante interno roto`,
          );
        }
        const allocationAmount = allocations.get(row.id);
        if (allocationAmount === undefined) {
          throw new InternalServerErrorException(
            'Factura bloqueada sin monto asignado; invariante interno roto',
          );
        }
        return { accountId: creditAccountIds[0], amount: allocationAmount };
      });
      const liabilityLines = groupLiabilityAmountsByAccount(liabilityPlanItems);

      const supplierPaymentId = randomUUID();
      const posted = await this.accountingEngine.postSupplierPaymentCollection(
        tx,
        {
          supplierPaymentId,
          description: buildSupplierPaymentOriginalDescription(
            supplier.legalName,
          ),
          accountingDateOnly: paymentDateString,
          accountingDestination: method.accountingDestination,
          liabilityLines,
          actorUserId: input.actorUserId,
          ipAddress: input.ipAddress,
        },
      );

      const created = await tx.supplierPayment.create({
        data: {
          id: supplierPaymentId,
          supplierId: input.supplierId,
          paymentDate,
          amount,
          currencyCode: settings.currencyCode,
          paymentMethodId: method.id,
          paymentMethodCode: method.code,
          paymentMethodName: method.name,
          reference,
          idempotencyKey,
          status: SupplierPaymentStatus.ACTIVE,
          postedEntryId: posted.id,
          createdByUserId: input.actorUserId,
          allocations: {
            create: Array.from(allocations.entries()).map(
              ([purchaseInvoiceId, allocationAmount]) => ({
                purchaseInvoiceId,
                amount: allocationAmount,
              }),
            ),
          },
        },
        select: SUPPLIER_PAYMENT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'SUPPLIER_PAYMENTS',
        action: AuditAction.SUPPLIER_PAYMENT_REGISTERED,
        entityType: 'SupplierPayment',
        entityId: created.id,
        description: `Pago a proveedor ${supplier.legalName} registrado`,
        metadata: {
          supplierId: input.supplierId,
          amount: amount.toFixed(2),
          invoiceCount: lockedInvoices.length,
          entryId: posted.id,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeSupplierPayment(created);
    });
  }

  // ==================================================================
  // Anulación
  // ==================================================================

  async cancel(
    input: CancelSupplierPaymentInput,
  ): Promise<SafeSupplierPayment> {
    assertCanManage(input.requesterRole);

    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new BadRequestException('reason es obligatorio');
    }
    if (reason.length > 300) {
      throw new BadRequestException(
        'reason no puede superar los 300 caracteres',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; status: string; supplierId: string }[]
      >(Prisma.sql`
        SELECT id, status, supplier_id AS "supplierId"
        FROM supplier_payments
        WHERE id = ${input.supplierPaymentId}::uuid
        FOR UPDATE
      `);
      const locked = rows[0];
      if (locked === undefined) {
        throw new NotFoundException('Pago a proveedor no encontrado');
      }
      if (locked.status !== SupplierPaymentStatus.ACTIVE) {
        throw new ConflictException(
          'Solo se puede anular un pago en estado ACTIVE',
        );
      }

      const supplier = await tx.supplier.findUniqueOrThrow({
        where: { id: locked.supplierId },
        select: { legalName: true },
      });

      const reversal = await this.accountingEngine.reverseOriginalForSource(
        tx,
        {
          sourceType: AccountingSourceType.SUPPLIER_PAYMENT,
          sourceId: locked.id,
          sourceNumber: supplier.legalName,
          postedAt: new Date(),
          actorUserId: input.actorUserId,
          ipAddress: input.ipAddress,
        },
      );

      const updated = await tx.supplierPayment.update({
        where: { id: locked.id },
        data: {
          status: SupplierPaymentStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledByUserId: input.actorUserId,
          cancellationReason: reason,
        },
        select: SUPPLIER_PAYMENT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'SUPPLIER_PAYMENTS',
        action: AuditAction.SUPPLIER_PAYMENT_CANCELLED,
        entityType: 'SupplierPayment',
        entityId: locked.id,
        description: `Pago a proveedor ${supplier.legalName} anulado`,
        metadata: { reason, reversalEntryId: reversal.id },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeSupplierPayment(updated);
    });
  }

  // ==================================================================
  // Helpers privados
  // ==================================================================

  private normalizeAllocations(
    allocations: CreateSupplierPaymentInput['allocations'],
  ): Map<string, Prisma.Decimal> {
    const result = new Map<string, Prisma.Decimal>();
    for (const allocation of allocations) {
      if (result.has(allocation.purchaseInvoiceId)) {
        throw new BadRequestException(
          'No se puede referenciar la misma factura dos veces en un pago',
        );
      }
      result.set(
        allocation.purchaseInvoiceId,
        parseSupplierPaymentAmount(allocation.amount),
      );
    }
    return result;
  }

  private normalizeDateOnly(raw: string, fieldName: string): Date {
    if (!isValidDateOnly(raw)) {
      throw new BadRequestException(
        `${fieldName} debe ser una fecha real en formato YYYY-MM-DD`,
      );
    }
    return toPrismaDate(raw);
  }

  private normalizeIdempotencyKey(raw: string | undefined): string | null {
    if (raw === undefined) {
      return null;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException(
        'idempotencyKey no puede estar en blanco si se provee',
      );
    }
    return trimmed;
  }
}

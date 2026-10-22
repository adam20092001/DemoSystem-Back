import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  PurchaseInvoiceStatus,
  RoleName,
  SupplierPaymentStatus,
} from '@prisma/client';
import { fromPrismaDate } from '../common/date/business-date';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import { computeAccountsPayableStatus } from './supplier-payment-calculator';
import {
  AccountsPayableDetail,
  AccountsPayableItem,
  AccountsPayablePaymentHistoryItem,
} from './types/accounts-payable-item';
import { ListAccountsPayableQuery } from './types/list-accounts-payable.query';

const ZERO = new Prisma.Decimal(0);

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** ADMIN/MANAGEMENT/ACCOUNTANT leen; SELLER/WAREHOUSE sin ningún acceso (A5.3, mismo criterio que el resto del dominio contable/compras). */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
]);

function assertCanRead(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar cuentas por pagar',
    );
  }
}

const AP_INVOICE_SELECT = {
  id: true,
  supplierId: true,
  documentType: true,
  documentSeries: true,
  documentNumber: true,
  issueDate: true,
  dueDate: true,
  currencyCode: true,
  totalAmount: true,
} satisfies Prisma.PurchaseInvoiceSelect;

type ApInvoiceRow = Prisma.PurchaseInvoiceGetPayload<{
  select: typeof AP_INVOICE_SELECT;
}>;

function toAccountsPayableItem(
  row: ApInvoiceRow,
  paidAmount: Prisma.Decimal,
): AccountsPayableItem {
  const balanceDue = row.totalAmount.minus(paidAmount);
  return {
    purchaseInvoiceId: row.id,
    supplierId: row.supplierId,
    documentType: row.documentType,
    documentSeries: row.documentSeries,
    documentNumber: row.documentNumber,
    issueDate: fromPrismaDate(row.issueDate),
    dueDate: row.dueDate !== null ? fromPrismaDate(row.dueDate) : null,
    currencyCode: row.currencyCode,
    originalAmount: row.totalAmount.toFixed(2),
    paidAmount: paidAmount.toFixed(2),
    balanceDue: balanceDue.toFixed(2),
    status: computeAccountsPayableStatus(paidAmount, row.totalAmount),
  };
}

/**
 * Cuentas por pagar (Fase A5.3): solo lectura, sin transacción (igual
 * criterio que AccountsReceivableService). Una cuenta por pagar es siempre
 * una PurchaseInvoice CONFIRMED — nunca nace de una recepción física
 * (A5.2b es independiente). paidAmount/balanceDue/status se calculan
 * SIEMPRE en tiempo de lectura a partir de SupplierPaymentAllocation de
 * pagos ACTIVE — nunca una columna duplicada que pudiera desincronizarse.
 */
@Injectable()
export class AccountsPayableService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: ListAccountsPayableQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<AccountsPayableItem>> {
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

    const where: Prisma.PurchaseInvoiceWhereInput = {
      status: PurchaseInvoiceStatus.CONFIRMED,
    };
    if (query.supplierId !== undefined) {
      where.supplierId = query.supplierId;
    }

    const [rows, total] = await Promise.all([
      this.prisma.purchaseInvoice.findMany({
        where,
        select: AP_INVOICE_SELECT,
        // Deuda más antigua primero, mismo criterio que AccountsReceivableService.
        orderBy: [{ issueDate: 'asc' }, { id: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.purchaseInvoice.count({ where }),
    ]);

    const paidMap = await this.computePaidAmounts(rows.map((row) => row.id));

    return {
      data: rows.map((row) =>
        toAccountsPayableItem(row, paidMap.get(row.id) ?? ZERO),
      ),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /** Detalle de una cuenta por pagar + historial completo de aplicación de pagos (ACTIVE y CANCELLED). */
  async getDetail(
    purchaseInvoiceId: string,
    requesterRole: RoleName,
  ): Promise<AccountsPayableDetail> {
    assertCanRead(requesterRole);

    const row = await this.prisma.purchaseInvoice.findUnique({
      where: { id: purchaseInvoiceId },
      select: { ...AP_INVOICE_SELECT, status: true },
    });
    // Una factura DRAFT/CANCELLED nunca es una cuenta por pagar (A5.3): se
    // trata igual que inexistente, mismo criterio 404 que el resto del
    // dominio ante un recurso fuera de alcance.
    if (row === null || row.status !== PurchaseInvoiceStatus.CONFIRMED) {
      throw new NotFoundException('Cuenta por pagar no encontrada');
    }

    const paidMap = await this.computePaidAmounts([row.id]);
    const paidAmount = paidMap.get(row.id) ?? ZERO;

    const allocations = await this.prisma.supplierPaymentAllocation.findMany({
      where: { purchaseInvoiceId: row.id },
      select: {
        amount: true,
        createdAt: true,
        supplierPayment: {
          select: {
            id: true,
            status: true,
            paymentDate: true,
            paymentMethodCode: true,
            reference: true,
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const payments: AccountsPayablePaymentHistoryItem[] = allocations.map(
      (allocation) => ({
        supplierPaymentId: allocation.supplierPayment.id,
        status: allocation.supplierPayment.status,
        paymentDate: fromPrismaDate(allocation.supplierPayment.paymentDate),
        amountApplied: allocation.amount.toFixed(2),
        paymentMethodCode: allocation.supplierPayment.paymentMethodCode,
        reference: allocation.supplierPayment.reference,
      }),
    );

    return { ...toAccountsPayableItem(row, paidAmount), payments };
  }

  private async computePaidAmounts(
    purchaseInvoiceIds: string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    if (purchaseInvoiceIds.length === 0) {
      return new Map();
    }
    const sums = await this.prisma.supplierPaymentAllocation.groupBy({
      by: ['purchaseInvoiceId'],
      where: {
        purchaseInvoiceId: { in: purchaseInvoiceIds },
        supplierPayment: { status: SupplierPaymentStatus.ACTIVE },
      },
      _sum: { amount: true },
    });
    return new Map(
      sums.map((row) => [row.purchaseInvoiceId, row._sum.amount ?? ZERO]),
    );
  }
}

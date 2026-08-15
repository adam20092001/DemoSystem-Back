import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, RoleName, SaleStatus } from '@prisma/client';
import {
  businessToday,
  endOfBusinessDayExclusiveUtc,
  isValidDateOnly,
  startOfBusinessDayUtc,
} from '../common/date/business-date';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import { calculateDaysOutstanding } from './receivable-calculator';
import { ListReceivablesQuery } from './types/list-receivables.query';
import { ReceivableItem } from './types/receivable-item';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const RECEIVABLE_SELECT = {
  id: true,
  number: true,
  customerId: true,
  customerName: true,
  customerDocumentNumber: true,
  sellerId: true,
  confirmedAt: true,
  total: true,
  paidAmount: true,
  balanceDue: true,
  paymentStatus: true,
} satisfies Prisma.SaleSelect;

type ReceivableRow = Prisma.SaleGetPayload<{
  select: typeof RECEIVABLE_SELECT;
}>;

/**
 * Roles con acceso de lectura a Cuentas por Cobrar (defensa en
 * profundidad; el controller igualmente rechaza con 403 vía guards).
 * WAREHOUSE no tiene ningún acceso, igual que en Sales/Payments.
 * `default` también falla cerrado.
 */
function hasReceivableReadAccess(role: RoleName): boolean {
  switch (role) {
    case RoleName.ADMIN:
    case RoleName.SELLER:
    case RoleName.MANAGEMENT:
      return true;
    case RoleName.WAREHOUSE:
    default:
      return false;
  }
}

function toReceivableItem(row: ReceivableRow, today: string): ReceivableItem {
  return {
    saleId: row.id,
    saleNumber: row.number,
    customerId: row.customerId,
    customerName: row.customerName,
    customerDocumentNumber: row.customerDocumentNumber,
    sellerId: row.sellerId,
    confirmedAt: row.confirmedAt,
    total: row.total.toFixed(2),
    paidAmount: row.paidAmount.toFixed(2),
    balanceDue: row.balanceDue.toFixed(2),
    paymentStatus: row.paymentStatus,
    daysOutstanding: calculateDaysOutstanding(row.confirmedAt, today),
  };
}

/**
 * Servicio de solo lectura (Bloque C): consulta directa vía PrismaService,
 * sin transacción (una consulta paginada de solo lectura no la necesita).
 * No depende de SalesService/PaymentsService/PaymentEngine: la definición
 * de cuenta por cobrar (Sale.status=ACTIVE AND balanceDue>0) se resuelve
 * enteramente con una consulta sobre `sales`, sin componer lógica de otros
 * servicios de escritura.
 */
@Injectable()
export class AccountsReceivableService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: ListReceivablesQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<ReceivableItem>> {
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

    if (!hasReceivableReadAccess(requesterRole)) {
      // Rol sin ningún acceso (WAREHOUSE u otro no contemplado): página
      // vacía sin tocar Prisma. Defensa en profundidad; el controller
      // igualmente rechaza esto con 403 en la capa HTTP.
      return { data: [], page, limit, total: 0, totalPages: 0 };
    }

    this.assertValidDateRangeQuery(query);

    // Definición fija de cuenta por cobrar (D-cerrado): ACTIVE + saldo
    // pendiente positivo. CANCELLED nunca aparece, incluso con su
    // balanceDue histórico congelado > 0. Público general nunca aparece
    // porque sales_generic_no_debt garantiza balanceDue=0 (sin filtro
    // especial). Un cliente actualmente BLOCKED no se excluye: si la deuda
    // es real, debe aparecer.
    const conditions: Prisma.SaleWhereInput[] = [
      { status: SaleStatus.ACTIVE },
      { balanceDue: { gt: 0 } },
    ];
    if (query.customerId !== undefined) {
      conditions.push({ customerId: query.customerId });
    }
    if (query.sellerId !== undefined) {
      conditions.push({ sellerId: query.sellerId });
    }
    if (query.confirmedFrom !== undefined) {
      conditions.push({
        confirmedAt: { gte: startOfBusinessDayUtc(query.confirmedFrom) },
      });
    }
    if (query.confirmedTo !== undefined) {
      conditions.push({
        confirmedAt: { lt: endOfBusinessDayExclusiveUtc(query.confirmedTo) },
      });
    }

    const where: Prisma.SaleWhereInput = { AND: conditions };

    const [rows, total] = await Promise.all([
      this.prisma.sale.findMany({
        where,
        select: RECEIVABLE_SELECT,
        // Deuda más antigua primero (oldest-first): la fecha de negocio de
        // confirmación es lo que hace significativa la columna
        // daysOutstanding en la pantalla de cuentas por cobrar.
        orderBy: [{ confirmedAt: 'asc' }, { id: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.sale.count({ where }),
    ]);

    const today = businessToday();
    return {
      data: rows.map((row) => toReceivableItem(row, today)),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  private assertValidDateRangeQuery(query: ListReceivablesQuery): void {
    if (
      query.confirmedFrom !== undefined &&
      !isValidDateOnly(query.confirmedFrom)
    ) {
      throw new BadRequestException(
        'confirmedFrom debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (
      query.confirmedTo !== undefined &&
      !isValidDateOnly(query.confirmedTo)
    ) {
      throw new BadRequestException(
        'confirmedTo debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (
      query.confirmedFrom !== undefined &&
      query.confirmedTo !== undefined &&
      query.confirmedFrom > query.confirmedTo
    ) {
      throw new BadRequestException(
        'confirmedFrom no puede ser posterior a confirmedTo',
      );
    }
  }
}

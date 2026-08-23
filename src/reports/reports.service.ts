import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import {
  endOfBusinessDayExclusiveUtc,
  isValidDateOnly,
  startOfBusinessDayUtc,
  toPrismaDate,
} from '../common/date/business-date';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import { PaymentsByMethodQueryDto } from './dto/payments-by-method-query.dto';
import { QuotesByStatusQueryDto } from './dto/quotes-by-status-query.dto';
import { SalesByCustomerQueryDto } from './dto/sales-by-customer-query.dto';
import { SalesByProductQueryDto } from './dto/sales-by-product-query.dto';
import { SalesBySellerQueryDto } from './dto/sales-by-seller-query.dto';
import {
  PaymentsByMethodRow,
  QuotesByStatusRow,
  SalesByCustomerRow,
  SalesByProductRow,
  SalesBySellerRow,
} from './types/report-results';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Roles con acceso de lectura a Reportes (defensa en profundidad; el
 * controller ya rechaza con 403 vía `@Roles()`/RolesGuard). A diferencia de
 * Contabilidad básica (solo ADMIN/MANAGEMENT), SELLER sí tiene acceso a los
 * 5 reportes de esta fase — son reportes operativos de venta/cobranza, no
 * el libro contable interno — pero sin restricción a sus propias ventas
 * (misma visibilidad de toda la empresa que ya tienen /sales, /quotes,
 * /payments). WAREHOUSE no tiene ningún acceso: sus reportes son
 * exclusivamente de inventario (R5/R6/R7, ya cubiertos fuera de este
 * módulo). `default` también falla cerrado.
 */
function hasReportReadAccess(role: RoleName): boolean {
  switch (role) {
    case RoleName.ADMIN:
    case RoleName.MANAGEMENT:
    case RoleName.SELLER:
      return true;
    case RoleName.WAREHOUSE:
    default:
      return false;
  }
}

function normalizePage(page: number | undefined): number {
  return page !== undefined && page > 0 ? Math.floor(page) : DEFAULT_PAGE;
}

function normalizeLimit(limit: number | undefined): number {
  return Math.min(
    limit !== undefined && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT,
    MAX_LIMIT,
  );
}

function emptyPage<T>(page: number, limit: number): PaginatedResult<T> {
  return { data: [], page, limit, total: 0, totalPages: 0 };
}

function toPaginated<T>(
  data: T[],
  page: number,
  limit: number,
  total: number,
): PaginatedResult<T> {
  return {
    data,
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}

// ---------------------------------------------------------------------------
// Filas crudas de las consultas SQL parametrizadas (R2/R3/R4). No exportadas:
// forma interna de $queryRaw, nunca cruzan la frontera del servicio.
// ---------------------------------------------------------------------------

interface SalesByProductRawRow {
  productId: string;
  sku: string;
  productName: string;
  categoryId: string;
  categoryName: string;
  quantitySold: Prisma.Decimal;
  totalSold: Prisma.Decimal;
}

interface SalesByCustomerRawRow {
  customerId: string;
  customerName: string;
  customerDocumentNumber: string | null;
  customerType: string | null;
  saleCount: number;
  totalSold: Prisma.Decimal;
  totalPaid: Prisma.Decimal;
  balance: Prisma.Decimal;
}

interface SalesBySellerAggRawRow {
  sellerId: string;
  username: string;
  firstName: string;
  lastName: string;
  saleCount: number;
  totalSold: Prisma.Decimal;
  totalCollected: Prisma.Decimal;
}

interface ConvertedQuotesRawRow {
  sellerId: string;
  convertedQuotes: number;
}

/**
 * Reportes de solo lectura (Fase 9, Bloque B). Consulta directa vía
 * PrismaService, sin transacción (lectura no la necesita) y sin depender de
 * ningún otro módulo de negocio (SalesModule/PaymentsModule/QuotesModule/
 * InventoryModule/AccountingModule/CustomersModule): las 5 consultas leen
 * las tablas subyacentes directamente. R2/R3/R4 usan SQL parametrizado
 * (Prisma.sql/$queryRaw) porque agregan con paginación sobre grupos —
 * funcionalidad que Prisma fluido no expresa de forma segura en esta
 * versión (sin precedente de `.groupBy()` en el repositorio); R8/R9 son
 * tabulares y usan Prisma fluido con `select` anidado, igual que
 * sale.mapper.ts.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * R2 — Ventas por producto. Hechos desde SaleItem de ventas ACTIVE
   * (Sale.confirmedAt en rango); CANCELLED nunca contribuye. Dimensión de
   * Product/Category ACTUALES: un producto real siempre produce una sola
   * fila agrupada. `categoryId` filtra por Product.categoryId actual (no
   * por la categoría histórica del snapshot de SaleItem).
   */
  async salesByProduct(
    query: SalesByProductQueryDto,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SalesByProductRow>> {
    const page = normalizePage(query.page);
    const limit = normalizeLimit(query.limit);
    const skip = (page - 1) * limit;

    if (!hasReportReadAccess(requesterRole)) {
      return emptyPage(page, limit);
    }
    this.assertValidDateRangeQuery(query.from, query.to);

    const conditions: Prisma.Sql[] = [
      Prisma.sql`s.status = 'ACTIVE'::"SaleStatus"`,
    ];
    if (query.from !== undefined) {
      conditions.push(
        Prisma.sql`s.confirmed_at >= ${startOfBusinessDayUtc(query.from)}`,
      );
    }
    if (query.to !== undefined) {
      conditions.push(
        Prisma.sql`s.confirmed_at < ${endOfBusinessDayExclusiveUtc(query.to)}`,
      );
    }
    if (query.categoryId !== undefined) {
      conditions.push(Prisma.sql`p.category_id = ${query.categoryId}::uuid`);
    }
    if (query.productId !== undefined) {
      conditions.push(Prisma.sql`si.product_id = ${query.productId}::uuid`);
    }
    const whereClause = Prisma.join(conditions, ' AND ');

    const rows = await this.prisma.$queryRaw<SalesByProductRawRow[]>(Prisma.sql`
      SELECT
        p.id   AS "productId",
        p.sku  AS "sku",
        p.name AS "productName",
        c.id   AS "categoryId",
        c.name AS "categoryName",
        SUM(si.quantity)   AS "quantitySold",
        SUM(si.line_total) AS "totalSold"
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      JOIN categories c ON c.id = p.category_id
      WHERE ${whereClause}
      GROUP BY p.id, p.sku, p.name, c.id, c.name
      ORDER BY SUM(si.line_total) DESC, p.id ASC
      LIMIT ${limit} OFFSET ${skip}
    `);

    const totalRows = await this.prisma.$queryRaw<
      { total: number }[]
    >(Prisma.sql`
      SELECT COUNT(*)::int AS "total"
      FROM (
        SELECT si.product_id
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        JOIN products p ON p.id = si.product_id
        WHERE ${whereClause}
        GROUP BY si.product_id
      ) grouped
    `);
    const total = totalRows[0]?.total ?? 0;

    return toPaginated(
      rows.map((row) => ({
        productId: row.productId,
        sku: row.sku,
        productName: row.productName,
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        quantitySold: row.quantitySold.toFixed(3),
        totalSold: row.totalSold.toFixed(2),
      })),
      page,
      limit,
      total,
    );
  }

  /**
   * R3 — Ventas por cliente. Siempre ACTIVE-only (sin parámetro status).
   * Hechos desde Sale (paidAmount/balanceDue operativos), nunca desde
   * Payment ni AccountingEntry. Dimensión de Customer ACTUAL: Público
   * general participa como un grupo normal, sin fila pseudo-cliente.
   */
  async salesByCustomer(
    query: SalesByCustomerQueryDto,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SalesByCustomerRow>> {
    const page = normalizePage(query.page);
    const limit = normalizeLimit(query.limit);
    const skip = (page - 1) * limit;

    if (!hasReportReadAccess(requesterRole)) {
      return emptyPage(page, limit);
    }
    this.assertValidDateRangeQuery(query.from, query.to);

    const conditions: Prisma.Sql[] = [
      Prisma.sql`s.status = 'ACTIVE'::"SaleStatus"`,
    ];
    if (query.from !== undefined) {
      conditions.push(
        Prisma.sql`s.confirmed_at >= ${startOfBusinessDayUtc(query.from)}`,
      );
    }
    if (query.to !== undefined) {
      conditions.push(
        Prisma.sql`s.confirmed_at < ${endOfBusinessDayExclusiveUtc(query.to)}`,
      );
    }
    if (query.customerId !== undefined) {
      conditions.push(Prisma.sql`s.customer_id = ${query.customerId}::uuid`);
    }
    if (query.customerType !== undefined) {
      conditions.push(
        Prisma.sql`c.customer_type = ${query.customerType}::"CustomerType"`,
      );
    }
    const whereClause = Prisma.join(conditions, ' AND ');

    const rows = await this.prisma.$queryRaw<
      SalesByCustomerRawRow[]
    >(Prisma.sql`
      SELECT
        c.id              AS "customerId",
        c.name            AS "customerName",
        c.document_number AS "customerDocumentNumber",
        c.customer_type   AS "customerType",
        COUNT(*)::int     AS "saleCount",
        SUM(s.total)       AS "totalSold",
        SUM(s.paid_amount) AS "totalPaid",
        SUM(s.balance_due) AS "balance"
      FROM sales s
      JOIN customers c ON c.id = s.customer_id
      WHERE ${whereClause}
      GROUP BY c.id, c.name, c.document_number, c.customer_type
      ORDER BY SUM(s.total) DESC, c.id ASC
      LIMIT ${limit} OFFSET ${skip}
    `);

    const totalRows = await this.prisma.$queryRaw<
      { total: number }[]
    >(Prisma.sql`
      SELECT COUNT(*)::int AS "total"
      FROM (
        SELECT s.customer_id
        FROM sales s
        JOIN customers c ON c.id = s.customer_id
        WHERE ${whereClause}
        GROUP BY s.customer_id
      ) grouped
    `);
    const total = totalRows[0]?.total ?? 0;

    return toPaginated(
      rows.map((row) => ({
        customerId: row.customerId,
        customerName: row.customerName,
        customerDocumentNumber: row.customerDocumentNumber,
        customerType: row.customerType as SalesByCustomerRow['customerType'],
        saleCount: row.saleCount,
        totalSold: row.totalSold.toFixed(2),
        totalPaid: row.totalPaid.toFixed(2),
        balance: row.balance.toFixed(2),
      })),
      page,
      limit,
      total,
    );
  }

  /**
   * R4 — Ventas por vendedor (CRÍTICO). El cohorte de Sale ACTIVE con
   * confirmedAt en rango define los grupos (un vendedor sin ventas
   * elegibles no aparece). totalCollected suma Payment ACTIVE cuyo saleId
   * pertenece a ese cohorte — NUNCA filtrado por Payment.paidAt: un pago
   * fuera del rango de fechas del reporte igual cuenta si su venta está en
   * el cohorte. convertedQuotes cuenta Quote CONVERTED por Quote.issueDate
   * en el MISMO rango, de forma completamente independiente (no depende de
   * si la venta resultante sigue activa). Ninguno de los dos se usa para
   * filtrar los grupos: un vendedor con 0 cobros o 0 conversiones sigue
   * apareciendo con "0.00"/0.
   */
  async salesBySeller(
    query: SalesBySellerQueryDto,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SalesBySellerRow>> {
    const page = normalizePage(query.page);
    const limit = normalizeLimit(query.limit);
    const skip = (page - 1) * limit;

    if (!hasReportReadAccess(requesterRole)) {
      return emptyPage(page, limit);
    }
    this.assertValidDateRangeQuery(query.from, query.to);

    const cohortConditions: Prisma.Sql[] = [
      Prisma.sql`s.status = 'ACTIVE'::"SaleStatus"`,
    ];
    if (query.from !== undefined) {
      cohortConditions.push(
        Prisma.sql`s.confirmed_at >= ${startOfBusinessDayUtc(query.from)}`,
      );
    }
    if (query.to !== undefined) {
      cohortConditions.push(
        Prisma.sql`s.confirmed_at < ${endOfBusinessDayExclusiveUtc(query.to)}`,
      );
    }
    if (query.sellerId !== undefined) {
      cohortConditions.push(Prisma.sql`s.seller_id = ${query.sellerId}::uuid`);
    }
    const cohortWhereClause = Prisma.join(cohortConditions, ' AND ');

    const rows = await this.prisma.$queryRaw<
      SalesBySellerAggRawRow[]
    >(Prisma.sql`
      WITH eligible_sales AS (
        SELECT s.id, s.seller_id, s.total
        FROM sales s
        WHERE ${cohortWhereClause}
      ),
      sale_agg AS (
        SELECT seller_id, COUNT(*)::int AS sale_count, SUM(total) AS total_sold
        FROM eligible_sales
        GROUP BY seller_id
      ),
      payment_agg AS (
        SELECT es.seller_id, SUM(pay.amount) AS total_collected
        FROM eligible_sales es
        JOIN payments pay ON pay.sale_id = es.id
        WHERE pay.status = 'ACTIVE'::"PaymentStatus"
        GROUP BY es.seller_id
      )
      SELECT
        u.id         AS "sellerId",
        u.username   AS "username",
        u.first_name AS "firstName",
        u.last_name  AS "lastName",
        sa.sale_count AS "saleCount",
        sa.total_sold AS "totalSold",
        COALESCE(pa.total_collected, 0::numeric) AS "totalCollected"
      FROM sale_agg sa
      JOIN users u ON u.id = sa.seller_id
      LEFT JOIN payment_agg pa ON pa.seller_id = sa.seller_id
      ORDER BY sa.total_sold DESC, sa.seller_id ASC
      LIMIT ${limit} OFFSET ${skip}
    `);

    const totalRows = await this.prisma.$queryRaw<
      { total: number }[]
    >(Prisma.sql`
      SELECT COUNT(DISTINCT s.seller_id)::int AS "total"
      FROM sales s
      WHERE ${cohortWhereClause}
    `);
    const total = totalRows[0]?.total ?? 0;

    const pageSellerIds = rows.map((row) => row.sellerId);
    const convertedQuotesBySeller = new Map<string, number>();
    if (pageSellerIds.length > 0) {
      const quoteConditions: Prisma.Sql[] = [
        Prisma.sql`q.status = 'CONVERTED'::"QuoteStatus"`,
        Prisma.sql`q.seller_id IN (${Prisma.join(pageSellerIds.map((id) => Prisma.sql`${id}::uuid`))})`,
      ];
      if (query.from !== undefined) {
        quoteConditions.push(
          Prisma.sql`q.issue_date >= ${toPrismaDate(query.from)}`,
        );
      }
      if (query.to !== undefined) {
        quoteConditions.push(
          Prisma.sql`q.issue_date <= ${toPrismaDate(query.to)}`,
        );
      }
      const convertedRows = await this.prisma.$queryRaw<
        ConvertedQuotesRawRow[]
      >(Prisma.sql`
        SELECT q.seller_id AS "sellerId", COUNT(*)::int AS "convertedQuotes"
        FROM quotes q
        WHERE ${Prisma.join(quoteConditions, ' AND ')}
        GROUP BY q.seller_id
      `);
      for (const row of convertedRows) {
        convertedQuotesBySeller.set(row.sellerId, row.convertedQuotes);
      }
    }

    return toPaginated(
      rows.map((row) => ({
        seller: {
          id: row.sellerId,
          username: row.username,
          firstName: row.firstName,
          lastName: row.lastName,
        },
        saleCount: row.saleCount,
        totalSold: row.totalSold.toFixed(2),
        totalCollected: row.totalCollected.toFixed(2),
        convertedQuotes: convertedQuotesBySeller.get(row.sellerId) ?? 0,
      })),
      page,
      limit,
      total,
    );
  }

  /**
   * R8 — Cotizaciones por estado. Tabular, todos los estados visibles sin
   * exclusión implícita. customerName es el snapshot guardado en Quote
   * (nunca una relectura de Customer vigente). `from`/`to` filtran
   * Quote.issueDate (@db.Date), límites inclusivos vía toPrismaDate, mismo
   * criterio que QuotesService. resultingSale permanece visible aunque la
   * venta generada haya sido anulada después.
   */
  async quotesByStatus(
    query: QuotesByStatusQueryDto,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<QuotesByStatusRow>> {
    const page = normalizePage(query.page);
    const limit = normalizeLimit(query.limit);
    const skip = (page - 1) * limit;

    if (!hasReportReadAccess(requesterRole)) {
      return emptyPage(page, limit);
    }
    this.assertValidDateRangeQuery(query.from, query.to);

    const conditions: Prisma.QuoteWhereInput[] = [];
    if (query.from !== undefined) {
      conditions.push({ issueDate: { gte: toPrismaDate(query.from) } });
    }
    if (query.to !== undefined) {
      conditions.push({ issueDate: { lte: toPrismaDate(query.to) } });
    }
    if (query.status !== undefined) {
      conditions.push({ status: query.status });
    }
    if (query.sellerId !== undefined) {
      conditions.push({ sellerId: query.sellerId });
    }
    if (query.customerId !== undefined) {
      conditions.push({ customerId: query.customerId });
    }
    const where: Prisma.QuoteWhereInput =
      conditions.length > 0 ? { AND: conditions } : {};

    const [rows, total] = await Promise.all([
      this.prisma.quote.findMany({
        where,
        select: {
          id: true,
          number: true,
          customerName: true,
          total: true,
          status: true,
          sale: { select: { id: true, number: true } },
        },
        orderBy: [{ issueDate: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.quote.count({ where }),
    ]);

    return toPaginated(
      rows.map((row) => ({
        quoteId: row.id,
        quoteNumber: row.number,
        customerName: row.customerName,
        total: row.total.toFixed(2),
        status: row.status,
        resultingSale:
          row.sale !== null
            ? { saleId: row.sale.id, saleNumber: row.sale.number }
            : null,
      })),
      page,
      limit,
      total,
    );
  }

  /**
   * R9 — Pagos por método. Pese al nombre, es TABULAR (una fila por
   * Payment), nunca agrupado. Todos los estados de Payment son visibles por
   * defecto (la exclusión de CANCELLED es una regla de agregados/Dashboard,
   * no de este listado histórico). `from`/`to` filtran Payment.paidAt
   * (instante real). saleNumber/customerName vienen del snapshot de la
   * Sale asociada; `reference` se expone tal cual.
   */
  async paymentsByMethod(
    query: PaymentsByMethodQueryDto,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<PaymentsByMethodRow>> {
    const page = normalizePage(query.page);
    const limit = normalizeLimit(query.limit);
    const skip = (page - 1) * limit;

    if (!hasReportReadAccess(requesterRole)) {
      return emptyPage(page, limit);
    }
    this.assertValidDateRangeQuery(query.from, query.to);

    const conditions: Prisma.PaymentWhereInput[] = [];
    if (query.from !== undefined) {
      conditions.push({ paidAt: { gte: startOfBusinessDayUtc(query.from) } });
    }
    if (query.to !== undefined) {
      conditions.push({
        paidAt: { lt: endOfBusinessDayExclusiveUtc(query.to) },
      });
    }
    if (query.method !== undefined) {
      conditions.push({ method: query.method });
    }
    if (query.status !== undefined) {
      conditions.push({ status: query.status });
    }
    if (query.createdByUserId !== undefined) {
      conditions.push({ createdByUserId: query.createdByUserId });
    }
    const where: Prisma.PaymentWhereInput =
      conditions.length > 0 ? { AND: conditions } : {};

    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        select: {
          id: true,
          paidAt: true,
          saleId: true,
          method: true,
          reference: true,
          amount: true,
          status: true,
          sale: { select: { number: true, customerName: true } },
          createdBy: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return toPaginated(
      rows.map((row) => ({
        paidAt: row.paidAt,
        paymentId: row.id,
        saleId: row.saleId,
        saleNumber: row.sale.number,
        customerName: row.sale.customerName,
        method: row.method,
        reference: row.reference,
        amount: row.amount.toFixed(2),
        status: row.status,
        createdBy: row.createdBy,
      })),
      page,
      limit,
      total,
    );
  }

  /**
   * Revalida formato/calendario y `from <= to` en el propio servicio, sin
   * confiar en que el DTO HTTP ya lo hizo (mismo criterio que
   * AccountingService/SalesService/PaymentsService/QuotesService). La
   * comparación lexicográfica de strings "YYYY-MM-DD" coincide con el
   * orden cronológico.
   */
  private assertValidDateRangeQuery(from?: string, to?: string): void {
    if (from !== undefined && !isValidDateOnly(from)) {
      throw new BadRequestException(
        'from debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (to !== undefined && !isValidDateOnly(to)) {
      throw new BadRequestException(
        'to debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (from !== undefined && to !== undefined && from > to) {
      throw new BadRequestException('from no puede ser posterior a to');
    }
  }
}

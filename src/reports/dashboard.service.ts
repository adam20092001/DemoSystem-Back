import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Prisma,
  PaymentStatus,
  QuoteStatus,
  RoleName,
  SaleStatus,
} from '@prisma/client';
import {
  businessToday,
  endOfBusinessDayExclusiveUtc,
  isValidDateOnly,
  startOfBusinessDayUtc,
  toPrismaDate,
} from '../common/date/business-date';
import { PrismaService } from '../database/prisma.service';
import { calculateDaysOutstanding } from '../payments/receivable-calculator';
import { buildEffectiveQuoteStatusCondition } from '../quotes/quote-calculator';
import {
  DashboardCollectionsSection,
  DashboardLowStockSection,
  DashboardPeriod,
  DashboardQuery,
  DashboardQuotesSection,
  DashboardReceivablesSection,
  DashboardResult,
  DashboardSalesSection,
} from './types/dashboard';

/**
 * Orden de negocio estable de QuoteStatus: se toma directamente de los
 * valores del enum generado por Prisma (Object.values preserva el orden de
 * declaración del enum en schema.prisma — PENDING, ACCEPTED, REJECTED,
 * EXPIRED, CONVERTED), en vez de duplicar los cinco strings a mano en un
 * arreglo desconectado del enum real (Fase 9, Bloque C, §17). Un test
 * unitario verifica que los 5 valores aparecen exactamente una vez.
 */
const QUOTE_STATUS_ORDER: readonly QuoteStatus[] = Object.values(QuoteStatus);

const DASHBOARD_LOW_STOCK_LIMIT = 5;
const DASHBOARD_RECEIVABLES_OLDEST_LIMIT = 5;

const DASHBOARD_RECEIVABLE_SELECT = {
  id: true,
  number: true,
  customerId: true,
  customerName: true,
  confirmedAt: true,
  total: true,
  paidAmount: true,
  balanceDue: true,
} satisfies Prisma.SaleSelect;

type DashboardReceivableRow = Prisma.SaleGetPayload<{
  select: typeof DASHBOARD_RECEIVABLE_SELECT;
}>;

/** Fila cruda del stock bajo (mismo patrón parametrizado que InventoryService.listLowStock). */
interface DashboardLowStockRawRow {
  id: string;
  sku: string;
  name: string;
  stockCurrent: Prisma.Decimal;
  stockMinimum: Prisma.Decimal;
}

interface DashboardSectionVisibility {
  sales: boolean;
  collections: boolean;
  lowStock: boolean;
  quotes: boolean;
  receivables: boolean;
}

/**
 * Matriz de roles cerrada (Fase 9, Bloque C, §7). WAREHOUSE ve únicamente
 * stock bajo; SELLER ve todo salvo stock bajo; ADMIN/MANAGEMENT ven las 5
 * secciones. Cualquier rol no contemplado falla cerrado (las 5 en false):
 * ninguna sección se calcula, nunca se ejecuta la consulta correspondiente.
 */
function resolveSectionVisibility(role: RoleName): DashboardSectionVisibility {
  switch (role) {
    case RoleName.ADMIN:
    case RoleName.MANAGEMENT:
      return {
        sales: true,
        collections: true,
        lowStock: true,
        quotes: true,
        receivables: true,
      };
    case RoleName.SELLER:
      return {
        sales: true,
        collections: true,
        lowStock: false,
        quotes: true,
        receivables: true,
      };
    case RoleName.WAREHOUSE:
      return {
        sales: false,
        collections: false,
        lowStock: true,
        quotes: false,
        receivables: false,
      };
    default:
      return {
        sales: false,
        collections: false,
        lowStock: false,
        quotes: false,
        receivables: false,
      };
  }
}

/**
 * Primer día calendario del mes de `dateOnly` (YYYY-MM-DD), por simple
 * sustitución del componente de día — `dateOnly` ya es una fecha de negocio
 * America/Lima resuelta por businessToday(), así que esto no introduce un
 * segundo sistema de huso horario: solo reformatea un string ya correcto.
 */
function firstDayOfLimaMonth(dateOnly: string): string {
  const [year, month] = dateOnly.split('-');
  return `${year}-${month}-01`;
}

/**
 * Dashboard compuesto de solo lectura (Fase 9, Bloque C). Consulta directa
 * vía PrismaService, sin transacción (varias lecturas normales; pequeñas
 * diferencias de instante entre secciones son aceptables en un MVP de
 * Dashboard, no se abre una transacción de lectura larga para "congelar"
 * las tarjetas). No depende de SalesService/PaymentsService/QuotesService/
 * InventoryService/AccountingModule ni de sus engines: cada sección se
 * resuelve con consultas propias sobre las tablas subyacentes. No inyecta
 * AuditService: GET /dashboard nunca genera AuditLog.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(
    query: DashboardQuery,
    requesterRole: RoleName,
  ): Promise<DashboardResult> {
    // El período se resuelve/valida siempre, sin importar el rol: es un
    // eco de entrada genérico (no una de las 5 secciones), así que un rol
    // sin ninguna sección visible igual debe recibir 400 ante una query
    // mal formada y el período correcto en cualquier otro caso. Esta
    // resolución es pura (sin tocar Prisma), así que no viola la regla de
    // "cero consultas" para roles sin acceso.
    const period = this.resolvePeriod(query);
    const visibility = resolveSectionVisibility(requesterRole);

    const periodStart = startOfBusinessDayUtc(period.from);
    const periodEndExclusive = endOfBusinessDayExclusiveUtc(period.to);

    // CRÍTICO: una sección oculta nunca ejecuta su consulta. El operador
    // ternario decide ANTES de invocar el método privado correspondiente
    // (Promise.resolve(null) en la rama oculta), no después de consultarla
    // y descartar el resultado.
    const [sales, collections, lowStock, quotes, receivables] =
      await Promise.all([
        visibility.sales
          ? this.getSalesSection(periodStart, periodEndExclusive)
          : Promise.resolve(null),
        visibility.collections
          ? this.getCollectionsSection(periodStart, periodEndExclusive)
          : Promise.resolve(null),
        visibility.lowStock ? this.getLowStockSection() : Promise.resolve(null),
        visibility.quotes
          ? this.getQuotesSection(period.from, period.to)
          : Promise.resolve(null),
        visibility.receivables
          ? this.getReceivablesSection()
          : Promise.resolve(null),
      ]);

    return { period, sales, collections, lowStock, quotes, receivables };
  }

  /**
   * Ambos lados o ninguno (rango de un solo lado -> 400); si ambos se
   * omiten, el default es el mes calendario actual America/Lima (desde el
   * día 1 hasta hoy, ambos inclusive) vía businessToday() — nunca la fecha
   * local del servidor ni CURRENT_DATE de PostgreSQL. Revalida formato/
   * calendario aunque el DTO ya lo hizo (mismo criterio defensivo que el
   * resto del dominio) y `from <= to`.
   */
  private resolvePeriod(query: DashboardQuery): DashboardPeriod {
    const hasFrom = query.from !== undefined;
    const hasTo = query.to !== undefined;

    if (hasFrom !== hasTo) {
      throw new BadRequestException(
        'from y to deben proporcionarse juntos: no se admite un rango de un solo lado',
      );
    }

    if (!hasFrom && !hasTo) {
      const today = businessToday();
      return { from: firstDayOfLimaMonth(today), to: today };
    }

    const from = query.from as string;
    const to = query.to as string;
    if (!isValidDateOnly(from)) {
      throw new BadRequestException(
        'from debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (!isValidDateOnly(to)) {
      throw new BadRequestException(
        'to debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (from > to) {
      throw new BadRequestException('from no puede ser posterior a to');
    }
    return { from, to };
  }

  /** Sale ACTIVE con confirmedAt en el período. CANCELLED nunca cuenta; nunca AccountingEntry. */
  private async getSalesSection(
    periodStart: Date,
    periodEndExclusive: Date,
  ): Promise<DashboardSalesSection> {
    const agg = await this.prisma.sale.aggregate({
      where: {
        status: SaleStatus.ACTIVE,
        confirmedAt: { gte: periodStart, lt: periodEndExclusive },
      },
      _count: { _all: true },
      _sum: { total: true },
    });
    return {
      count: agg._count._all,
      total: (agg._sum.total ?? new Prisma.Decimal(0)).toFixed(2),
    };
  }

  /**
   * Payment ACTIVE con paidAt en el período. Semántica de estado neto
   * actual: un pago cuyo paidAt cae en el período pero que HOY está
   * CANCELLED no cuenta. Nunca se deriva de Sale.paidAmount ni de
   * AccountingEntry.
   */
  private async getCollectionsSection(
    periodStart: Date,
    periodEndExclusive: Date,
  ): Promise<DashboardCollectionsSection> {
    const agg = await this.prisma.payment.aggregate({
      where: {
        status: PaymentStatus.ACTIVE,
        paidAt: { gte: periodStart, lt: periodEndExclusive },
      },
      _count: { _all: true },
      _sum: { amount: true },
    });
    return {
      count: agg._count._all,
      total: (agg._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
    };
  }

  /**
   * Estado actual, SIN filtro de período (misma regla operativa exacta que
   * GET /inventory/low-stock): producto físico, inventariado, producto/
   * categoría/unidad ACTIVE, stockCurrent <= stockMinimum. SQL parametrizado
   * porque Prisma fluido no compara dos columnas de la misma fila; sin
   * parámetros de usuario en esta consulta (tarjeta fija del Dashboard), por
   * lo que no hace falta el arreglo dinámico de condiciones de
   * InventoryService/ReportsService. Orden: mayor faltante primero
   * (stockMinimum - stockCurrent DESC), desempate sku ASC, id ASC. `count`
   * es independiente del límite de 5 filas (consulta separada).
   */
  private async getLowStockSection(): Promise<DashboardLowStockSection> {
    const rows = await this.prisma.$queryRaw<
      DashboardLowStockRawRow[]
    >(Prisma.sql`
      SELECT
        p.id            AS "id",
        p.sku           AS "sku",
        p.name          AS "name",
        p.stock_current AS "stockCurrent",
        p.stock_minimum AS "stockMinimum"
      FROM products p
      JOIN categories c ON c.id = p.category_id
      JOIN units u ON u.id = p.unit_id
      WHERE p.status = 'ACTIVE'::"ProductStatus"
        AND p.product_type = 'PRODUCT'::"ProductType"
        AND p.is_inventory_tracked = true
        AND c.status = 'ACTIVE'::"CategoryStatus"
        AND u.status = 'ACTIVE'::"UnitStatus"
        AND p.stock_current <= p.stock_minimum
      ORDER BY (p.stock_minimum - p.stock_current) DESC, p.sku ASC, p.id ASC
      LIMIT ${DASHBOARD_LOW_STOCK_LIMIT}
    `);

    const totalRows = await this.prisma.$queryRaw<
      { total: number }[]
    >(Prisma.sql`
      SELECT COUNT(*)::int AS "total"
      FROM products p
      JOIN categories c ON c.id = p.category_id
      JOIN units u ON u.id = p.unit_id
      WHERE p.status = 'ACTIVE'::"ProductStatus"
        AND p.product_type = 'PRODUCT'::"ProductType"
        AND p.is_inventory_tracked = true
        AND c.status = 'ACTIVE'::"CategoryStatus"
        AND u.status = 'ACTIVE'::"UnitStatus"
        AND p.stock_current <= p.stock_minimum
    `);

    return {
      count: totalRows[0]?.total ?? 0,
      items: rows.map((row) => ({
        productId: row.id,
        sku: row.sku,
        productName: row.name,
        stockCurrent: row.stockCurrent.toFixed(3),
        stockMinimum: row.stockMinimum.toFixed(3),
        difference: row.stockMinimum.minus(row.stockCurrent).toFixed(3),
      })),
    };
  }

  /**
   * Quote.issueDate en el período (columna @db.Date: gte/lte inclusive vía
   * toPrismaDate, mismo criterio que QuotesService/R8) determina QUÉ
   * cotizaciones entran — `total` cuenta exactamente esas, sin importar su
   * estado. `byStatus` recorre QUOTE_STATUS_ORDER con un `count()` por
   * estado EFECTIVO (idéntico a GET /quotes y R8, vía
   * buildEffectiveQuoteStatusCondition — nunca el status crudo almacenado),
   * evaluado contra la fecha de negocio America/Lima ACTUAL (businessToday()
   * al momento de la consulta), NUNCA contra `from`/`to` del Dashboard: son
   * dos conceptos deliberadamente independientes — el período selecciona
   * QUÉ cotizaciones se consideran (issueDate); la fecha de negocio actual
   * determina su estado EFECTIVO (vigencia). Exactamente 6 consultas de
   * cardinalidad fija (1 total + 5 por estado, cardinalidad fija del enum
   * — no es N+1 sobre filas de datos), así que los 5 valores aparecen
   * siempre, incluidos los de conteo cero, sin depender del orden
   * accidental de un GROUP BY de base de datos. Las 5 condiciones de
   * estado EFECTIVO son mutuamente excluyentes y colectivamente
   * exhaustivas (cada Quote cae en exactamente un bucket): la invariante
   * `total === sum(byStatus[*].count)` se cumple estructuralmente, incluso
   * con cotizaciones vencidas.
   */
  private async getQuotesSection(
    from: string,
    to: string,
  ): Promise<DashboardQuotesSection> {
    const baseWhere: Prisma.QuoteWhereInput = {
      issueDate: { gte: toPrismaDate(from), lte: toPrismaDate(to) },
    };
    const businessDateAsDate = toPrismaDate(businessToday());

    const [total, counts] = await Promise.all([
      this.prisma.quote.count({ where: baseWhere }),
      Promise.all(
        QUOTE_STATUS_ORDER.map((status) =>
          this.prisma.quote.count({
            where: {
              AND: [
                baseWhere,
                buildEffectiveQuoteStatusCondition(status, businessDateAsDate),
              ],
            },
          }),
        ),
      ),
    ]);

    const byStatus = QUOTE_STATUS_ORDER.map((status, index) => ({
      status,
      count: counts[index],
    }));

    return { total, byStatus };
  }

  /**
   * Estado actual, SIN filtro de período (Sale.status=ACTIVE AND
   * balanceDue>0 — misma definición exacta que AccountsReceivableService,
   * nunca Payment ni AccountingEntry). `oldest` reutiliza
   * calculateDaysOutstanding() (función pura de payments/receivable-
   * calculator.ts) en vez de duplicar la fórmula de antigüedad; no se
   * inyecta AccountsReceivableService: es solo un import de función pura,
   * no una dependencia de servicio de dominio.
   */
  private async getReceivablesSection(): Promise<DashboardReceivablesSection> {
    const where: Prisma.SaleWhereInput = {
      status: SaleStatus.ACTIVE,
      balanceDue: { gt: 0 },
    };

    const [agg, oldestRows] = await Promise.all([
      this.prisma.sale.aggregate({
        where,
        _count: { _all: true },
        _sum: { balanceDue: true },
      }),
      this.prisma.sale.findMany({
        where,
        select: DASHBOARD_RECEIVABLE_SELECT,
        orderBy: [{ confirmedAt: 'asc' }, { id: 'asc' }],
        take: DASHBOARD_RECEIVABLES_OLDEST_LIMIT,
      }),
    ]);

    const today = businessToday();
    return {
      count: agg._count._all,
      totalBalance: (agg._sum.balanceDue ?? new Prisma.Decimal(0)).toFixed(2),
      oldest: oldestRows.map((row: DashboardReceivableRow) => ({
        saleId: row.id,
        saleNumber: row.number,
        customerId: row.customerId,
        customerName: row.customerName,
        confirmedAt: row.confirmedAt,
        total: row.total.toFixed(2),
        paidAmount: row.paidAmount.toFixed(2),
        balanceDue: row.balanceDue.toFixed(2),
        daysOutstanding: calculateDaysOutstanding(row.confirmedAt, today),
      })),
    };
  }
}

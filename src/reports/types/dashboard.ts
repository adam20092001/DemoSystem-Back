import { QuoteStatus } from '@prisma/client';

/**
 * Query interna ya transformada, sin decoradores ni dependencias HTTP
 * (mismo criterio que report-queries.ts). `from`/`to` deben venir juntos o
 * ambos ausentes: DashboardService valida esa regla y aplica el default de
 * mes calendario actual America/Lima cuando ambos faltan.
 */
export interface DashboardQuery {
  from?: string;
  to?: string;
}

/** Rango resuelto (ya validado/completado con el default), ambos límites inclusivos en fecha de negocio America/Lima. */
export interface DashboardPeriod {
  from: string;
  to: string;
}

/** R-Sales del Dashboard: Sale ACTIVE con confirmedAt en el período. */
export interface DashboardSalesSection {
  count: number;
  total: string;
}

/** R-Collections del Dashboard: Payment ACTIVE con paidAt en el período (semántica de estado neto actual: un pago anulado no cuenta aunque su paidAt caiga en el período). */
export interface DashboardCollectionsSection {
  count: number;
  total: string;
}

/** Fila mínima de stock bajo, mismo criterio de forma que products/inventory (sin categoría/marca: la tarjeta del Dashboard es deliberadamente mínima). */
export interface DashboardLowStockItem {
  productId: string;
  sku: string;
  productName: string;
  stockCurrent: string;
  stockMinimum: string;
  difference: string;
}

/** Estado actual (sin período): igual regla operativa que GET /inventory/low-stock. */
export interface DashboardLowStockSection {
  count: number;
  items: DashboardLowStockItem[];
}

/** Una fila por cada valor del enum QuoteStatus, incluidos los de conteo cero. */
export interface DashboardQuoteStatusCount {
  status: QuoteStatus;
  count: number;
}

/** Quote.issueDate en el período, todos los estados. */
export interface DashboardQuotesSection {
  total: number;
  byStatus: DashboardQuoteStatusCount[];
}

/** Fila mínima de cuenta por cobrar más antigua (Sale.status=ACTIVE AND balanceDue>0), estado actual sin filtro de período. */
export interface DashboardReceivableItem {
  saleId: string;
  saleNumber: string;
  customerId: string;
  customerName: string;
  confirmedAt: Date;
  total: string;
  paidAmount: string;
  balanceDue: string;
  daysOutstanding: number;
}

export interface DashboardReceivablesSection {
  count: number;
  totalBalance: string;
  oldest: DashboardReceivableItem[];
}

/**
 * Respuesta compuesta única de GET /dashboard. Cada sección es `null`
 * cuando el rol solicitante no tiene visibilidad (Fase 9, Bloque C, matriz
 * de roles cerrada) — nunca se ejecuta la consulta correspondiente en ese
 * caso, la sección simplemente no se calcula.
 */
export interface DashboardResult {
  period: DashboardPeriod;
  sales: DashboardSalesSection | null;
  collections: DashboardCollectionsSection | null;
  lowStock: DashboardLowStockSection | null;
  quotes: DashboardQuotesSection | null;
  receivables: DashboardReceivablesSection | null;
}

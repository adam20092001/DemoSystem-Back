import { CustomerType, PaymentStatus, QuoteStatus } from '@prisma/client';

/** Identidad mínima segura de un usuario: nunca email/rol/campos de seguridad. */
export interface ReportSafeUser {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

/**
 * R2 — Ventas por producto. Dimensión de PRODUCTO ACTUAL (Product/Category
 * vigentes, no snapshot histórico): un producto real siempre produce una
 * sola fila agrupada aunque su nombre/SKU histórico en SaleItem haya
 * cambiado. Los hechos (quantitySold/totalSold) siempre vienen de SaleItem
 * de ventas ACTIVE — nunca de Product ni de AccountingEntry.
 */
export interface SalesByProductRow {
  productId: string;
  sku: string;
  productName: string;
  categoryId: string;
  categoryName: string;
  quantitySold: string;
  totalSold: string;
}

/**
 * R3 — Ventas por cliente. Dimensión de CLIENTE ACTUAL (Customer vigente):
 * Público general participa como un grupo normal por su customerId real,
 * sin fila pseudo-cliente. Hechos siempre desde Sale ACTIVE (paidAmount/
 * balanceDue operativos, nunca desde Payment ni AccountingEntry).
 */
export interface SalesByCustomerRow {
  customerId: string;
  customerName: string;
  customerDocumentNumber: string | null;
  customerType: CustomerType | null;
  saleCount: number;
  totalSold: string;
  totalPaid: string;
  balance: string;
}

/**
 * R4 — Ventas por vendedor. totalCollected proviene de Payment ACTIVE cuyo
 * saleId pertenece al cohorte de Sale elegibles de ESTE vendedor (nunca
 * filtrado por Payment.paidAt); convertedQuotes cuenta Quote CONVERTED por
 * Quote.issueDate en el mismo rango, independientemente del estado actual
 * de la Sale resultante. Ambos pueden ser cero sin que la fila desaparezca.
 */
export interface SalesBySellerRow {
  seller: ReportSafeUser;
  saleCount: number;
  totalSold: string;
  totalCollected: string;
  convertedQuotes: number;
}

/** Referencia mínima a la venta generada; null si la cotización no fue convertida. */
export interface QuoteResultingSale {
  saleId: string;
  saleNumber: string;
}

/**
 * R8 — Cotizaciones por estado. Fila histórica tabular: todos los estados
 * son visibles, sin exclusión implícita. customerName es el snapshot
 * guardado en Quote (nunca una relectura de Customer vigente).
 * resultingSale permanece visible aunque la venta generada haya sido
 * anulada después: la fuente histórica es la Cotización, no el estado
 * actual de la Sale.
 */
export interface QuotesByStatusRow {
  quoteId: string;
  quoteNumber: string;
  customerName: string;
  total: string;
  status: QuoteStatus;
  resultingSale: QuoteResultingSale | null;
}

/**
 * R9 — Pagos por método. A pesar del nombre de la ruta, es TABULAR (una
 * fila por Payment), nunca agrupado. Todos los estados son visibles
 * (ACTIVE y CANCELLED): la regla "los pagos anulados no suman" aplica a
 * agregados/Dashboard, no a la visibilidad de este listado histórico.
 * saleNumber/customerName vienen del snapshot de la Sale asociada (nunca
 * una relectura de Customer vigente). reference se expone tal cual: el
 * Documento Maestro lo exige explícitamente para este reporte, a
 * diferencia del libro contable de la Fase 8, que lo oculta.
 */
export interface PaymentsByMethodRow {
  paidAt: Date;
  paymentId: string;
  saleId: string;
  saleNumber: string;
  customerName: string;
  /** Snapshot histórico Payment.paymentMethodCode (Ticket C, Bloque C3), nunca el code actual del PaymentMethod dinámico. */
  method: string;
  /** Snapshot histórico Payment.paymentMethodName — campo aditivo, nunca el name actual. */
  methodName: string;
  reference: string | null;
  amount: string;
  status: PaymentStatus;
  createdBy: ReportSafeUser;
}

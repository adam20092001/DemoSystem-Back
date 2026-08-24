import { ApiProperty } from '@nestjs/swagger';
import {
  CustomerType,
  PaymentMethod,
  PaymentStatus,
  QuoteStatus,
} from '@prisma/client';

/** Identidad mínima segura de un usuario: nunca email/rol/campos de seguridad. */
export class ReportSafeUserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

// ---------------------------------------------------------------------------
// R2 — Ventas por producto
// ---------------------------------------------------------------------------

/**
 * Fila agrupada por PRODUCTO ACTUAL (Product/Category vigentes). quantitySold
 * y totalSold provienen únicamente de SaleItem de ventas ACTIVE dentro del
 * rango; las ventas CANCELLED nunca contribuyen.
 */
export class SalesByProductRowResponseDto {
  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty()
  productName!: string;

  @ApiProperty({ format: 'uuid' })
  categoryId!: string;

  @ApiProperty()
  categoryName!: string;

  @ApiProperty({
    type: String,
    example: '12.000',
    description: 'Cantidad, 3 decimales fijos.',
  })
  quantitySold!: string;

  @ApiProperty({
    type: String,
    example: '1250.00',
    description: 'Monto, 2 decimales fijos.',
  })
  totalSold!: string;
}

export class PaginatedSalesByProductResponseDto {
  @ApiProperty({ type: [SalesByProductRowResponseDto] })
  data!: SalesByProductRowResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty({
    description:
      'Cantidad de grupos (productos) que cumplen el filtro, no de filas de SaleItem.',
  })
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

// ---------------------------------------------------------------------------
// R3 — Ventas por cliente
// ---------------------------------------------------------------------------

/**
 * Fila agrupada por CLIENTE ACTUAL (Customer vigente). Hechos siempre desde
 * Sale ACTIVE (paidAmount/balanceDue operativos): nunca desde Payment ni
 * AccountingEntry. Público general participa como un grupo normal.
 */
export class SalesByCustomerRowResponseDto {
  @ApiProperty({ format: 'uuid' })
  customerId!: string;

  @ApiProperty()
  customerName!: string;

  @ApiProperty({ type: String, nullable: true })
  customerDocumentNumber!: string | null;

  @ApiProperty({ enum: CustomerType, nullable: true })
  customerType!: CustomerType | null;

  @ApiProperty()
  saleCount!: number;

  @ApiProperty({ type: String, example: '1250.00' })
  totalSold!: string;

  @ApiProperty({ type: String, example: '1000.00' })
  totalPaid!: string;

  @ApiProperty({ type: String, example: '250.00' })
  balance!: string;
}

export class PaginatedSalesByCustomerResponseDto {
  @ApiProperty({ type: [SalesByCustomerRowResponseDto] })
  data!: SalesByCustomerRowResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty({
    description:
      'Cantidad de grupos (clientes) que cumplen el filtro, no de filas de Sale.',
  })
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

// ---------------------------------------------------------------------------
// R4 — Ventas por vendedor
// ---------------------------------------------------------------------------

/**
 * Fila agrupada por vendedor. totalCollected proviene de Payment ACTIVE cuyo
 * saleId pertenece al cohorte de Sale elegibles de este vendedor (nunca
 * filtrado por Payment.paidAt). convertedQuotes cuenta Quote CONVERTED por
 * Quote.issueDate en el mismo rango, independientemente del estado actual de
 * la Sale resultante. Ambos pueden ser "0.00"/0 sin que la fila desaparezca.
 */
export class SalesBySellerRowResponseDto {
  @ApiProperty({ type: ReportSafeUserResponseDto })
  seller!: ReportSafeUserResponseDto;

  @ApiProperty()
  saleCount!: number;

  @ApiProperty({ type: String, example: '1250.00' })
  totalSold!: string;

  @ApiProperty({ type: String, example: '900.00' })
  totalCollected!: string;

  @ApiProperty()
  convertedQuotes!: number;
}

export class PaginatedSalesBySellerResponseDto {
  @ApiProperty({ type: [SalesBySellerRowResponseDto] })
  data!: SalesBySellerRowResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty({
    description:
      'Cantidad de grupos (vendedores) que cumplen el filtro, no de filas de Sale.',
  })
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

// ---------------------------------------------------------------------------
// R8 — Cotizaciones por estado
// ---------------------------------------------------------------------------

/** Referencia mínima a la venta generada por la cotización; null si no fue convertida. */
export class QuoteResultingSaleResponseDto {
  @ApiProperty({ format: 'uuid' })
  saleId!: string;

  @ApiProperty()
  saleNumber!: string;
}

/**
 * Fila histórica tabular (no agrupada). customerName es el snapshot guardado
 * en Quote (nunca una relectura de Customer vigente). resultingSale
 * permanece visible aunque la venta generada haya sido anulada después.
 */
export class QuotesByStatusRowResponseDto {
  @ApiProperty({ format: 'uuid' })
  quoteId!: string;

  @ApiProperty()
  quoteNumber!: string;

  @ApiProperty()
  customerName!: string;

  @ApiProperty({ type: String, example: '350.00' })
  total!: string;

  @ApiProperty({ enum: QuoteStatus })
  status!: QuoteStatus;

  @ApiProperty({ type: QuoteResultingSaleResponseDto, nullable: true })
  resultingSale!: QuoteResultingSaleResponseDto | null;
}

export class PaginatedQuotesByStatusResponseDto {
  @ApiProperty({ type: [QuotesByStatusRowResponseDto] })
  data!: QuotesByStatusRowResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty({
    description:
      'Cantidad de cotizaciones que cumplen el filtro (sin agregación).',
  })
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

// ---------------------------------------------------------------------------
// R9 — Pagos por método
// ---------------------------------------------------------------------------

/**
 * Fila histórica tabular (una fila por Payment, pese al nombre de la ruta).
 * Todos los estados de Payment son visibles por defecto. saleNumber/
 * customerName vienen del snapshot de la Sale asociada. reference se expone
 * tal cual (a diferencia del libro contable de Fase 8, que lo oculta).
 */
export class PaymentsByMethodRowResponseDto {
  @ApiProperty({ type: String, format: 'date-time' })
  paidAt!: Date;

  @ApiProperty({ format: 'uuid' })
  paymentId!: string;

  @ApiProperty({ format: 'uuid' })
  saleId!: string;

  @ApiProperty()
  saleNumber!: string;

  @ApiProperty()
  customerName!: string;

  @ApiProperty({ enum: PaymentMethod })
  method!: PaymentMethod;

  @ApiProperty({ type: String, nullable: true })
  reference!: string | null;

  @ApiProperty({ type: String, example: '500.00' })
  amount!: string;

  @ApiProperty({ enum: PaymentStatus })
  status!: PaymentStatus;

  @ApiProperty({ type: ReportSafeUserResponseDto })
  createdBy!: ReportSafeUserResponseDto;
}

export class PaginatedPaymentsByMethodResponseDto {
  @ApiProperty({ type: [PaymentsByMethodRowResponseDto] })
  data!: PaymentsByMethodRowResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty({
    description: 'Cantidad de pagos que cumplen el filtro (sin agregación).',
  })
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

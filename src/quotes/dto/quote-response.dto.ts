import { ApiProperty } from '@nestjs/swagger';
import {
  CustomerDocumentType,
  CustomerType,
  QuoteStatus,
} from '@prisma/client';

export class QuoteStockInfoResponseDto {
  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
    example: '50.000',
  })
  currentStock!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
    example: '2.500',
  })
  requestedQuantity!: string;

  @ApiProperty()
  sufficient!: boolean;
}

/** Identidad mínima del vendedor: nunca role/passwordHash/campos de seguridad. */
export class QuoteSellerResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

export class QuoteItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  productSku!: string;

  @ApiProperty()
  productName!: string;

  @ApiProperty()
  unitCode!: string;

  @ApiProperty()
  unitName!: string;

  @ApiProperty()
  unitAbbreviation!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
    example: '2.500',
  })
  quantity!: string;

  @ApiProperty({
    type: String,
    description:
      'Decimal con 2 decimales fijos, como string. Snapshot de Product.salePrice al momento de crear/editar.',
    example: '199.90',
  })
  unitPrice!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 2 decimales fijos, como string.',
    example: '499.75',
  })
  lineTotal!: string;

  @ApiProperty({
    type: QuoteStockInfoResponseDto,
    nullable: true,
    description:
      'Calculado en vivo a partir del stock actual del producto; nunca persistido. null cuando el producto no es inventariable (SERVICE o isInventoryTracked=false). Insuficiente NO impide crear/editar la cotización.',
  })
  stockInfo!: QuoteStockInfoResponseDto | null;
}

/** Forma de listado: sin ítems ni identidad completa del vendedor (ver QuoteResponseDto para el detalle). */
export class QuoteListItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'COT-000001' })
  number!: string;

  @ApiProperty({
    enum: QuoteStatus,
    description:
      'Estado EFECTIVO: puede reportar EXPIRED por fecha de vencimiento aunque nunca se haya escrito ese valor en la base.',
  })
  status!: QuoteStatus;

  @ApiProperty({ format: 'uuid' })
  customerId!: string;

  @ApiProperty()
  customerName!: string;

  @ApiProperty({ type: String, nullable: true })
  customerDocumentNumber!: string | null;

  @ApiProperty({ format: 'uuid' })
  sellerId!: string;

  @ApiProperty({ type: String, example: '2026-03-15' })
  issueDate!: string;

  @ApiProperty({ type: String, example: '2026-04-15' })
  expirationDate!: string;

  @ApiProperty({ type: String })
  subtotal!: string;

  @ApiProperty({ type: String })
  discountAmount!: string;

  @ApiProperty({
    type: String,
    description:
      'IGV a nivel de documento (Fase 10, Bloque C): "0.00" si taxEnabled=false; ROUND(taxableBase * taxRate / 100, 2) si true. Snapshot histórico congelado al crear/actualizar comercialmente.',
  })
  taxAmount!: string;

  @ApiProperty({ type: String })
  total!: string;

  @ApiProperty({
    type: String,
    example: 'PEN',
    description:
      'Fase 11, Bloque B: contexto de moneda vigente al calcular este snapshot comercial. Congelado; nunca se actualiza si CompanySettings cambia después.',
  })
  currencyCode!: string;

  @ApiProperty({
    description:
      'Fase 11, Bloque B: si el IGV estaba activo al calcular este snapshot comercial. Congelado, mismo criterio que taxAmount.',
  })
  taxEnabled!: boolean;

  @ApiProperty({
    type: String,
    description:
      'Fase 11, Bloque B: tasa de IGV vigente al calcular este snapshot comercial. Congelada, mismo criterio que taxAmount.',
  })
  taxRate!: string;

  @ApiProperty()
  itemCount!: number;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

/** Forma de detalle: snapshot completo de cliente, vendedor seguro e ítems con stockInfo en vivo. */
export class QuoteResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'COT-000001' })
  number!: string;

  @ApiProperty({ enum: QuoteStatus })
  status!: QuoteStatus;

  @ApiProperty({ format: 'uuid' })
  customerId!: string;

  @ApiProperty({
    enum: CustomerType,
    description:
      'Snapshot al momento de crear; nunca null (el cliente genérico no puede cotizar).',
  })
  customerType!: CustomerType;

  @ApiProperty({ enum: CustomerDocumentType, nullable: true })
  customerDocumentType!: CustomerDocumentType | null;

  @ApiProperty({ type: String, nullable: true })
  customerDocumentNumber!: string | null;

  @ApiProperty()
  customerName!: string;

  @ApiProperty({ type: String, nullable: true })
  customerAddress!: string | null;

  @ApiProperty({ type: QuoteSellerResponseDto })
  seller!: QuoteSellerResponseDto;

  @ApiProperty({ type: String, example: '2026-03-15' })
  issueDate!: string;

  @ApiProperty({ type: String, example: '2026-04-15' })
  expirationDate!: string;

  @ApiProperty({
    type: String,
    description:
      'Subtotal ANTES de impuesto (persistido). Con pricesIncludeTax=true: taxableBase + discountAmount, derivado de precios finales. Con pricesIncludeTax=false (histórico): Σ lineTotal antes de impuesto.',
  })
  subtotal!: string;

  @ApiProperty({
    type: String,
    description:
      'Descuento persistido, SIEMPRE antes de impuesto. Para el descuento que ve el cliente use customerDiscountAmount.',
  })
  discountAmount!: string;

  @ApiProperty({
    type: String,
    description:
      'IGV. Con pricesIncludeTax=true: IGV CONTENIDO en el total (total - taxableBase, desglosado del precio final). Con pricesIncludeTax=false (histórico, Fase 10, Bloque C): IGV sumado a nivel de documento, ROUND(taxableBase * taxRate / 100, 2). "0.00" si taxEnabled=false.',
  })
  taxAmount!: string;

  @ApiProperty({
    type: String,
    description:
      'Importe a pagar. Siempre subtotal - discountAmount + taxAmount. Con pricesIncludeTax=true también es itemsTotal - customerDiscountAmount.',
  })
  total!: string;

  @ApiProperty({
    type: String,
    example: 'PEN',
    description:
      'Fase 11, Bloque B: contexto de moneda vigente al calcular este snapshot comercial. Congelado; nunca se actualiza si CompanySettings cambia después.',
  })
  currencyCode!: string;

  @ApiProperty({
    description:
      'Fase 11, Bloque B: si el IGV estaba activo al calcular este snapshot comercial. Congelado, mismo criterio que taxAmount.',
  })
  taxEnabled!: boolean;

  @ApiProperty({
    type: String,
    description:
      'Fase 11, Bloque B: tasa de IGV vigente al calcular este snapshot comercial. Congelada, mismo criterio que taxAmount.',
  })
  taxRate!: string;

  @ApiProperty({
    description:
      'R2: semántica de precios del documento (no si el IGV está activo). true = unitPrice/lineTotal son precios FINALES al cliente y el IGV está incluido en ellos. false = cotización histórica: unitPrice/lineTotal antes de impuesto e IGV sumado encima; sus montos nunca se recalculan.',
  })
  pricesIncludeTax!: boolean;

  @ApiProperty({
    type: String,
    description:
      'R2: Σ lineTotal de los ítems. Con pricesIncludeTax=true, importe a precio final antes del descuento; con false, importe antes de impuesto (igual a subtotal).',
  })
  itemsTotal!: string;

  @ApiProperty({
    type: String,
    description:
      'R2: descuento que ve el cliente. Con pricesIncludeTax=true: itemsTotal - total (descuento sobre el precio final). Con false (histórico): igual a discountAmount, porque el descuento se aplicó antes de sumar el IGV.',
  })
  customerDiscountAmount!: string;

  @ApiProperty({
    type: String,
    description: 'R2: base imponible, subtotal - discountAmount.',
  })
  taxableBase!: string;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: [QuoteItemResponseDto] })
  items!: QuoteItemResponseDto[];

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class PaginatedQuotesResponseDto {
  @ApiProperty({ type: [QuoteListItemResponseDto] })
  data!: QuoteListItemResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

import { ApiProperty } from '@nestjs/swagger';
import {
  CustomerDocumentType,
  ElectronicDocumentStatus,
  FiscalDocumentType,
  LineDiscountType,
} from '@prisma/client';

export class ElectronicDocumentItemResponseDto {
  @ApiProperty()
  lineNumber!: number;

  @ApiProperty()
  productSku!: string;

  @ApiProperty({
    description:
      'Snapshot de Product.name al momento de la emisión (nunca releído).',
  })
  description!: string;

  @ApiProperty()
  unitCode!: string;

  @ApiProperty()
  unitName!: string;

  @ApiProperty()
  unitAbbreviation!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
    example: '2.000',
  })
  quantity!: string;

  @ApiProperty({ type: String, example: '50.00' })
  unitPrice!: string;

  @ApiProperty({ type: String, example: '100.00' })
  lineTotal!: string;

  @ApiProperty({
    enum: LineDiscountType,
    nullable: true,
    description:
      'NR-03: copiado EXACTAMENTE del SaleItem de origen; null cuando esa línea no tiene descuento individual.',
  })
  discountType!: LineDiscountType | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Decimal con 2 decimales fijos, como string. Soles si discountType=FIXED; porcentaje si PERCENT; null si no hay descuento de línea.',
  })
  discountValue!: string | null;

  @ApiProperty({
    type: String,
    description:
      'Decimal con 2 decimales fijos, como string. Siempre presente; "0.00" cuando la línea no tiene descuento.',
    example: '0.00',
  })
  discountAmount!: string;
}

/** Forma de listado: sin ítems, sin identidad del emisor (ver el detalle). */
export class ElectronicDocumentListItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  saleId!: string;

  @ApiProperty({ example: 'NV-000001' })
  saleNumber!: string;

  @ApiProperty({ enum: FiscalDocumentType })
  documentType!: FiscalDocumentType;

  @ApiProperty({ example: 'F001' })
  series!: string;

  @ApiProperty({ example: 1 })
  number!: number;

  @ApiProperty({
    example: 'F001-00000001',
    description:
      'Computado (series + número relleno a 8 dígitos). Nunca almacenado en base de datos.',
  })
  fullNumber!: string;

  @ApiProperty({
    enum: ElectronicDocumentStatus,
    description:
      'CREATED: número ya asignado, aún no comunicado. SUBMITTED: en curso o comunicado, en espera de resolución — PUEDE representar un resultado remoto DESCONOCIDO (nunca se reintenta automáticamente). SUBMISSION_FAILED: fallo técnico confirmado, reintentable con el MISMO número. ACCEPTED/REJECTED: resolución final del proveedor.',
  })
  status!: ElectronicDocumentStatus;

  @ApiProperty({ example: 'PEN' })
  currencyCode!: string;

  @ApiProperty({ enum: CustomerDocumentType, nullable: true })
  customerDocumentType!: CustomerDocumentType | null;

  @ApiProperty({ type: String, nullable: true })
  customerDocumentNumber!: string | null;

  @ApiProperty()
  customerName!: string;

  @ApiProperty({ type: String })
  subtotal!: string;

  @ApiProperty({ type: String })
  discountAmount!: string;

  @ApiProperty({ type: String, description: 'subtotal - discountAmount.' })
  taxableBase!: string;

  @ApiProperty({ type: String })
  taxAmount!: string;

  @ApiProperty({ type: String })
  total!: string;

  @ApiProperty({
    example: 'MOCK',
    description:
      'Proveedor que procesó el envío. "MOCK" es el proveedor de demostración de este bloque: su ACCEPTED es un resultado simulado, nunca una aceptación real de SUNAT.',
  })
  providerCode!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Vocabulario opaco del proveedor (p. ej. "ACCEPTED", "TECHNICAL_FAILURE", "UNKNOWN_OUTCOME").',
  })
  providerStatus!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  issuedAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastSubmittedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acceptedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  rejectedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

/** Forma de detalle: agrega identidad del emisor, dirección del cliente, ítems y diagnóstico saneado del proveedor. */
export class ElectronicDocumentResponseDto extends ElectronicDocumentListItemResponseDto {
  @ApiProperty({
    description:
      'R2: semántica de precios del documento, copiada de la venta al emitir. true = unitPrice/lineTotal son precios FINALES al cliente y el IGV está incluido en ellos (taxableBase + taxAmount = total). false = documento histórico: unitPrice/lineTotal antes de impuesto e IGV sumado encima.',
  })
  pricesIncludeTax!: boolean;

  @ApiProperty({
    description:
      'R2: si el IGV estaba activo al confirmar la venta de origen (snapshot congelado de la venta, nunca la configuración vigente). El documento fiscal no persiste este dato por sí mismo.',
  })
  taxEnabled!: boolean;

  @ApiProperty({
    type: String,
    example: '18.00',
    description:
      'R2: tasa de IGV congelada de la venta de origen (nunca la configuración vigente).',
  })
  taxRate!: string;

  @ApiProperty({
    type: String,
    description:
      'R2: Σ lineTotal de los ítems persistidos. Con pricesIncludeTax=true, importe a precio final antes del descuento; con false, importe antes de impuesto.',
  })
  itemsTotal!: string;

  @ApiProperty({
    type: String,
    description:
      'R2: descuento que ve el cliente. Con pricesIncludeTax=true: itemsTotal - total. Con false (histórico): igual a discountAmount, aplicado antes de sumar el IGV. discountAmount sigue siendo el persistido antes de impuesto.',
  })
  customerDiscountAmount!: string;

  @ApiProperty({ example: '20100000001' })
  issuerTaxId!: string;

  @ApiProperty()
  issuerBusinessName!: string;

  @ApiProperty({ type: String, nullable: true })
  issuerAddress!: string | null;

  @ApiProperty({ type: String, nullable: true })
  customerAddress!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Mensaje ya saneado del proveedor. Nunca el cuerpo/stack crudo.',
  })
  providerMessage!: string | null;

  @ApiProperty({
    description:
      'Cantidad de intentos de envío realizados (issue inicial + reintentos).',
  })
  submissionCount!: number;

  @ApiProperty({ type: [ElectronicDocumentItemResponseDto] })
  items!: ElectronicDocumentItemResponseDto[];
}

export class PaginatedElectronicDocumentsResponseDto {
  @ApiProperty({ type: [ElectronicDocumentListItemResponseDto] })
  data!: ElectronicDocumentListItemResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

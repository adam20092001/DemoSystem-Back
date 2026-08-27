import { ApiProperty } from '@nestjs/swagger';
import {
  CustomerDocumentType,
  ElectronicDocumentStatus,
  FiscalDocumentType,
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

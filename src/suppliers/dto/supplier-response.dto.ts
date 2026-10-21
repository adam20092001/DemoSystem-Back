import { ApiProperty } from '@nestjs/swagger';
import { SupplierDocumentType, SupplierStatus } from '@prisma/client';

/**
 * Documenta exactamente los 15 campos de SafeSupplier. Es documentación de
 * contrato/Swagger, no una segunda fuente de mapeo: SUPPLIER_SAFE_SELECT +
 * toSafeSupplier() siguen siendo la única frontera real contra fuga de datos.
 */
export class SupplierResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: SupplierDocumentType })
  documentType!: SupplierDocumentType;

  @ApiProperty()
  documentNumber!: string;

  @ApiProperty({ example: 'PE', description: 'ISO 3166-1 alpha-2.' })
  countryCode!: string;

  @ApiProperty()
  legalName!: string;

  @ApiProperty({ nullable: true, type: String })
  tradeName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  contactName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  phone!: string | null;

  @ApiProperty({ nullable: true, type: String })
  email!: string | null;

  @ApiProperty({ nullable: true, type: String })
  address!: string | null;

  @ApiProperty({ nullable: true, type: String })
  internalNotes!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Puramente informativo: ningún cálculo ni posteo contable lo usa todavía.',
  })
  defaultCurrencyCode!: string | null;

  @ApiProperty({ enum: SupplierStatus })
  status!: SupplierStatus;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class PaginatedSuppliersResponseDto {
  @ApiProperty({ type: [SupplierResponseDto] })
  data!: SupplierResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

import { ApiProperty } from '@nestjs/swagger';
import {
  CustomerDocumentType,
  CustomerStage,
  CustomerStatus,
  CustomerType,
} from '@prisma/client';

/**
 * Documenta exactamente los 17 campos de SafeCustomer. Es documentación de
 * contrato/Swagger, no una segunda fuente de mapeo: CUSTOMER_SAFE_SELECT +
 * toSafeCustomer() siguen siendo la única frontera real contra fuga de datos.
 */
export class CustomerResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'null para todo cliente normal; "PUBLIC_GENERAL" solo para el genérico.',
  })
  code!: string | null;

  @ApiProperty({
    enum: CustomerType,
    nullable: true,
    description: 'null únicamente para el cliente genérico "Público general".',
  })
  customerType!: CustomerType | null;

  @ApiProperty({ enum: CustomerStage })
  customerStage!: CustomerStage;

  @ApiProperty({ enum: CustomerDocumentType, nullable: true })
  documentType!: CustomerDocumentType | null;

  @ApiProperty({ nullable: true, type: String })
  documentNumber!: string | null;

  @ApiProperty()
  name!: string;

  @ApiProperty({ nullable: true, type: String })
  tradeName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  contactName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  email!: string | null;

  @ApiProperty({ nullable: true, type: String })
  phone!: string | null;

  @ApiProperty({ nullable: true, type: String })
  address!: string | null;

  @ApiProperty({ nullable: true, type: String })
  internalNotes!: string | null;

  @ApiProperty({
    description: 'true únicamente para el cliente genérico "Público general".',
  })
  isGeneric!: boolean;

  @ApiProperty({
    enum: CustomerStatus,
    description:
      'SELLER ve ACTIVE y BLOCKED (nunca INACTIVE). BLOCKED sigue siendo un estado de Customer, no de venta.',
  })
  status!: CustomerStatus;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class PaginatedCustomersResponseDto {
  @ApiProperty({ type: [CustomerResponseDto] })
  data!: CustomerResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

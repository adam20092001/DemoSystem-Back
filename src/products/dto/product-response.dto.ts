import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProductStatus, ProductType } from '@prisma/client';
import { ProductImageResponseDto } from './product-image-response.dto';
import { ProductSpecificationResponseDto } from './product-specification-response.dto';

export class CategorySummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;
}

export class UnitSummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  abbreviation!: string;

  @ApiProperty()
  allowDecimal!: boolean;
}

/**
 * Forma de listado: sin especificaciones ni descripción comercial.
 * internalNotes se omite por completo (no viaja ni siquiera como null)
 * cuando el rol solicitante es SELLER.
 */
export class ProductListItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ nullable: true, type: String })
  brand!: string | null;

  @ApiProperty({ enum: ProductType })
  productType!: ProductType;

  @ApiProperty({ type: CategorySummaryResponseDto })
  category!: CategorySummaryResponseDto;

  @ApiProperty({ type: UnitSummaryResponseDto })
  unit!: UnitSummaryResponseDto;

  @ApiProperty({
    type: String,
    description: 'Decimal con 2 decimales fijos, como string.',
    example: '199.90',
  })
  salePrice!: string;

  @ApiProperty()
  isInventoryTracked!: boolean;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
    example: '0.000',
  })
  stockCurrent!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
    example: '5.000',
  })
  stockMinimum!: string;

  @ApiProperty({ enum: ProductStatus })
  status!: ProductStatus;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Ausente por completo (no null) para el rol SELLER.',
  })
  internalNotes?: string | null;

  @ApiProperty({ type: ProductImageResponseDto, nullable: true })
  primaryImage!: ProductImageResponseDto | null;
}

export class ProductDetailResponseDto extends ProductListItemResponseDto {
  @ApiProperty({ nullable: true, type: String })
  commercialDescription!: string | null;

  @ApiProperty({ type: [ProductSpecificationResponseDto] })
  specifications!: ProductSpecificationResponseDto[];

  @ApiProperty({
    type: [ProductImageResponseDto],
    description: 'Ordenadas por isPrimary desc, sortOrder asc, createdAt asc.',
  })
  images!: ProductImageResponseDto[];
}

export class PaginatedProductsResponseDto {
  @ApiProperty({ type: [ProductListItemResponseDto] })
  data!: ProductListItemResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

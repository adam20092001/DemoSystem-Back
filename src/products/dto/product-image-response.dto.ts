import { ApiProperty } from '@nestjs/swagger';

/** Nunca incluye storagePath ni rutas absolutas: fileUrl es el único puntero al binario. */
export class ProductImageResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fileName!: string;

  @ApiProperty({ example: 'image/jpeg' })
  mimeType!: string;

  @ApiProperty()
  fileSize!: number;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  isPrimary!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({
    description: 'Endpoint protegido que sirve el binario.',
    example: '/api/v1/products/<productId>/images/<imageId>/file',
  })
  fileUrl!: string;
}

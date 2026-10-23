import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/** Decimal como texto, positivo, máximo 3 decimales (Decimal(14,3)). */
export const IMPORT_RECEIPT_LINK_QUANTITY_PATTERN = /^\d{1,11}(\.\d{1,3})?$/;

/**
 * id, status y toda auditoría de cancelación nunca se aceptan: son
 * valores de sistema. La línea de embarque se identifica por el `:id` de
 * la ruta, nunca por el body.
 */
export class CreateImportReceiptLinkDto {
  @ApiProperty({
    format: 'uuid',
    description: 'PurchaseReceiptLine ACTIVE existente.',
  })
  @IsUUID()
  purchaseReceiptLineId!: string;

  @ApiProperty({ type: String, example: '30.000' })
  @IsString()
  @Matches(IMPORT_RECEIPT_LINK_QUANTITY_PATTERN, {
    message:
      'linkedQuantity debe ser un decimal positivo, como texto, con máximo 3 decimales',
  })
  linkedQuantity!: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Opcional: reenviarla en un reintento devuelve el mismo vínculo ya creado.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;
}

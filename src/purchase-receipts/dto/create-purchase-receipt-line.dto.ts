import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';

/** Decimal como texto, positivo, máximo 3 decimales (mismo patrón que PurchaseInvoiceLine.quantity). */
export const RECEIPT_QUANTITY_PATTERN = /^\d{1,11}(\.\d{1,3})?$/;

export class CreatePurchaseReceiptLineDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  purchaseInvoiceLineId!: string;

  @ApiProperty({ type: String, example: '4.000' })
  @IsString()
  @Matches(RECEIPT_QUANTITY_PATTERN, {
    message:
      'quantity debe ser un decimal positivo, como texto, con máximo 3 decimales',
  })
  quantity!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'R2-B2. Ubicación de destino de ESTA línea (una por línea). Si se omite, MAIN/DEFAULT. Ubicación inexistente → 404; ubicación o almacén inactivos → 409.',
  })
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

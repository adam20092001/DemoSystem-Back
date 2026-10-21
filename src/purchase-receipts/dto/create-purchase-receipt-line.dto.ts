import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches } from 'class-validator';

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
}

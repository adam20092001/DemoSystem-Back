import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches } from 'class-validator';

/** Copia local del dominio HTTP, mismo criterio exacto que PAYMENT_AMOUNT_PATTERN/PURCHASE_MONEY_PATTERN. */
export const SUPPLIER_PAYMENT_ALLOCATION_AMOUNT_PATTERN =
  /^\d{1,12}(\.\d{1,2})?$/;

export class CreateSupplierPaymentAllocationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  purchaseInvoiceId!: string;

  @ApiProperty({ type: String, example: '150.00' })
  @IsString()
  @Matches(SUPPLIER_PAYMENT_ALLOCATION_AMOUNT_PATTERN, {
    message:
      'amount debe ser un decimal positivo, como texto, con máximo 2 decimales',
  })
  amount!: string;
}

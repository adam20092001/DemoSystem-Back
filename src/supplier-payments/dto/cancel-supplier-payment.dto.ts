import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { SUPPLIER_PAYMENT_CANCELLATION_REASON_MAX_LENGTH } from '../constants/supplier-payment.constants';

export class CancelSupplierPaymentDto {
  @ApiProperty({
    maxLength: SUPPLIER_PAYMENT_CANCELLATION_REASON_MAX_LENGTH,
    description: 'Motivo obligatorio de la anulación.',
    example: 'Pago registrado por error, se revierte',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUPPLIER_PAYMENT_CANCELLATION_REASON_MAX_LENGTH)
  reason!: string;
}

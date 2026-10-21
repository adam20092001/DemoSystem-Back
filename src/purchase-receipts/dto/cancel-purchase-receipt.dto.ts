import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CancelPurchaseReceiptDto {
  @ApiProperty({
    maxLength: 300,
    description: 'Motivo obligatorio de la anulación.',
    example: 'Mercadería dañada, se revierte el ingreso registrado por error',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason!: string;
}

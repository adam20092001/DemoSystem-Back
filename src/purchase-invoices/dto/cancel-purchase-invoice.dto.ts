import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CancelPurchaseInvoiceDto {
  @ApiProperty({
    maxLength: 300,
    description: 'Motivo obligatorio de la anulación.',
    example: 'Factura registrada con el proveedor incorrecto',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason!: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CreatePurchaseReceiptLineDto } from './create-purchase-receipt-line.dto';
import { IsDateOnly } from './is-date-only.decorator';

/**
 * id/status/cancelledAt/reclassificationEntryId/... nunca se aceptan: son
 * valores de sistema fijados por PurchaseReceiptsService. `idempotencyKey`
 * opcional: si se reenvía tal cual en un reintento, la misma recepción ya
 * creada se devuelve sin duplicar ningún efecto (stock, auditoría,
 * contabilidad).
 */
export class CreatePurchaseReceiptDto {
  @ApiPropertyOptional({
    type: String,
    example: '2026-10-25',
    description: 'Por defecto, la fecha de negocio actual si se omite.',
  })
  @IsOptional()
  @IsDateOnly()
  receivedDate?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Clave de idempotencia opcional, única por factura. Reenviarla tal cual en un reintento HTTP devuelve la MISMA recepción ya creada, sin duplicar ningún efecto.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;

  @ApiProperty({ type: [CreatePurchaseReceiptLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseReceiptLineDto)
  lines!: CreatePurchaseReceiptLineDto[];
}

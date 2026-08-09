import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CreateQuoteItemDto } from './create-quote-item.dto';
import { IsDateOnly, QUOTE_DISCOUNT_PATTERN } from './create-quote.dto';

/**
 * customerId/sellerId/number/status/issueDate/totales/snapshots nunca se
 * aceptan aquí: inmutables desde update() en la Fase 5 (sin reasignación de
 * cliente). notes vacío ("") limpia la nota — QuotesService ya normaliza
 * cadena en blanco a null, así que no hace falta un `null` explícito aquí.
 * items ausente conserva los ítems actuales; presente exige no vacío (el
 * objeto vacío `{}` es válido a nivel de DTO: QuotesService lo rechaza con
 * 400 por no tener ningún campo efectivo).
 */
export class UpdateQuoteDto {
  @ApiPropertyOptional({
    type: String,
    example: '2026-04-15',
    description: 'Fecha exacta YYYY-MM-DD (calendario real).',
  })
  @IsOptional()
  @IsDateOnly()
  expirationDate?: string;

  @ApiPropertyOptional({
    type: String,
    description: 'Decimal no negativo, como texto, máximo 2 decimales.',
    example: '10.00',
  })
  @IsOptional()
  @IsString()
  @Matches(QUOTE_DISCOUNT_PATTERN, {
    message:
      'discountAmount debe ser un decimal no negativo, como texto, con máximo 2 decimales',
  })
  discountAmount?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({ type: [CreateQuoteItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateQuoteItemDto)
  items?: CreateQuoteItemDto[];
}

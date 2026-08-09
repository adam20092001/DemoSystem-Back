import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { isValidDateOnly } from '../../common/date/business-date';
import { CreateQuoteItemDto } from './create-quote-item.dto';

/**
 * Valida formato Y calendario real (rechaza "2026-02-30", "2026-08-09T12:00:00Z",
 * 29 de febrero no bisiesto) reutilizando isValidDateOnly() del Bloque B en
 * vez de duplicar el algoritmo de fechas en la capa HTTP. Se define una sola
 * vez aquí y la reutilizan UpdateQuoteDto y ListQuotesQueryDto.
 */
export function IsDateOnly(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isDateOnly',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && isValidDateOnly(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} debe ser una fecha real en formato YYYY-MM-DD`;
        },
      },
    });
  };
}

/**
 * Mismo criterio textual que el dominio (quote-calculator.ts, Bloque B):
 * sin notación científica, máximo 2 decimales (Decimal(14,2)). ">=0" y la
 * comparación contra el subtotal las revalida QuotesService.
 */
export const QUOTE_DISCOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * Solo cubre la creación de una cotización normal. number/status/sellerId/
 * issueDate/subtotal/taxAmount/total/snapshots de cliente y producto/
 * unitPrice nunca se aceptan aquí: son valores de sistema calculados por
 * QuotesService (Bloque B), nunca controlados por el llamador. sellerId se
 * deriva exclusivamente del actor autenticado (D12).
 */
export class CreateQuoteDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  customerId!: string;

  @ApiProperty({
    type: String,
    example: '2026-04-15',
    description:
      'Fecha exacta YYYY-MM-DD (calendario real). Debe ser >= la fecha de emisión (hoy, America/Lima).',
  })
  @IsDateOnly()
  expirationDate!: string;

  @ApiPropertyOptional({
    type: String,
    description:
      'Decimal no negativo, como texto, máximo 2 decimales. Ausente equivale a "0".',
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

  @ApiProperty({ type: [CreateQuoteItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateQuoteItemDto)
  items!: CreateQuoteItemDto[];
}

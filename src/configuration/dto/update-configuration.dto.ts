import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Mismo criterio textual estricto que discountAmount en Quotes/Sales
 * (quote-calculator.ts): decimal no negativo como texto, sin notación
 * científica, máximo 2 decimales (Decimal(5,2)). Hasta 3 dígitos enteros
 * cubre el máximo válido "100.00"; el rango 0.00-100.00 lo revalida
 * ConfigurationService (no lo expresa el patrón). Compartido por
 * maxDiscountPercent (Bloque B) y taxRate (Bloque C): ambos son el mismo
 * tipo de columna (Decimal(5,2), 0.00-100.00) — nunca se inventa un segundo
 * formato de entrada Decimal para el mismo shape.
 */
export const PERCENT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;

/**
 * Recorta espacios perimetrales antes de que @IsEmail() evalúe el valor
 * crudo: sin esto, un email válido con espacios ("  x@x.com  ") sería
 * rechazado aquí. Mismo criterio exacto que UpdateCustomerDto.trimEmail. No
 * toca null: @IsOptional() sigue tratándolo como "limpiar email".
 */
function trimEmail({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Bloque A: campos de identidad y moneda. Bloque B (Fase 10): se agregan
 * quoteValidityDays y maxDiscountPercent. Bloque C: se agregan taxEnabled y
 * taxRate — con esto quedan activos los 10 campos editables aprobados;
 * ningún campo de CompanySettings permanece bloqueado.
 *
 * Los campos `| null` aceptan null explícito (limpiar el valor existente)
 * además de undefined (no tocar): @IsOptional() de class-validator omite el
 * resto de validadores cuando el valor es null, mismo criterio que
 * UpdateCategoryDto.
 */
export class UpdateConfigurationDto {
  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  businessName?: string;

  @ApiPropertyOptional({
    maxLength: 150,
    nullable: true,
    description: 'null limpia el nombre comercial existente.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  tradeName?: string | null;

  @ApiPropertyOptional({
    maxLength: 20,
    nullable: true,
    description: 'null limpia el identificador tributario existente.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  taxId?: string | null;

  @ApiPropertyOptional({
    maxLength: 300,
    nullable: true,
    description: 'null limpia la dirección existente.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string | null;

  @ApiPropertyOptional({
    maxLength: 30,
    nullable: true,
    description: 'null limpia el teléfono existente.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @ApiPropertyOptional({
    maxLength: 150,
    nullable: true,
    description: 'null limpia el correo existente.',
  })
  @IsOptional()
  @Transform(trimEmail)
  @IsEmail()
  @MaxLength(150)
  email?: string | null;

  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 3,
    example: 'PEN',
    description: 'Código ISO 4217 de 3 letras. Se normaliza a mayúsculas.',
  })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currencyCode?: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 5,
    example: 'S/',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(5)
  currencySymbol?: string;

  @ApiPropertyOptional({
    minimum: 1,
    example: 15,
    description:
      'Vigencia por defecto (días calendario) de una cotización nueva cuando no se envía expirationDate explícito. No modifica cotizaciones ya existentes.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  quoteValidityDays?: number;

  @ApiPropertyOptional({
    type: String,
    example: '10.00',
    description:
      'Decimal no negativo, como texto, entre "0.00" y "100.00", máximo 2 decimales. Límite superior configurado para el descuento de cotizaciones/ventas nuevas o comercialmente modificadas; nunca revalida documentos ya existentes.',
  })
  @IsOptional()
  @IsString()
  @Matches(PERCENT_PATTERN, {
    message:
      'maxDiscountPercent debe ser un decimal no negativo, como texto, con máximo 2 decimales',
  })
  maxDiscountPercent?: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'Activa/desactiva el cálculo de IGV a nivel de documento. El par (taxEnabled, taxRate) resultante debe satisfacer: si taxEnabled=true, taxRate > 0. Nunca afecta cotizaciones/ventas ya existentes.',
  })
  @IsOptional()
  @IsBoolean()
  taxEnabled?: boolean;

  @ApiPropertyOptional({
    type: String,
    example: '18.00',
    description:
      'Decimal no negativo, como texto, entre "0.00" y "100.00", máximo 2 decimales (mismo formato que maxDiscountPercent). Si taxEnabled resultante es true, debe ser > 0.',
  })
  @IsOptional()
  @IsString()
  @Matches(PERCENT_PATTERN, {
    message:
      'taxRate debe ser un decimal no negativo, como texto, con máximo 2 decimales',
  })
  taxRate?: string;
}

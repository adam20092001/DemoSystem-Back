import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  SaleDeliveryStatus,
  SalePaymentStatus,
  SaleStatus,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { isValidDateOnly } from '../../common/date/business-date';

/**
 * Valida formato Y calendario real (rechaza "2026-02-30",
 * "2026-08-10T10:00:00Z", 29 de febrero no bisiesto), reutilizando
 * isValidDateOnly() del común en vez de duplicar el algoritmo de fechas en
 * la capa HTTP. Definida localmente (no importada desde los DTO de
 * Quotes): CreateSaleDto no tiene ningún campo de fecha propio donde
 * definirla junto a su primer uso, y acoplar los DTOs de Ventas al archivo
 * de DTOs de Cotizaciones sería una dependencia cruzada de capa HTTP entre
 * dominios sin necesidad real (la única lógica compartida, el cálculo de
 * calendario, ya vive en business-date.ts).
 */
function IsDateOnly(validationOptions?: ValidationOptions) {
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

/** Sin orderBy/sort/direction: el orden es fijo (confirmedAt desc, id desc) en el servicio. */
export class ListSalesQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ enum: SaleStatus })
  @IsOptional()
  @IsEnum(SaleStatus)
  status?: SaleStatus;

  @ApiPropertyOptional({
    enum: SalePaymentStatus,
    description:
      'Incluye PARTIALLY_PAID por compatibilidad con la Fase 7; la Fase 6 nunca lo produce operativamente (sin modelo Payment todavía).',
  })
  @IsOptional()
  @IsEnum(SalePaymentStatus)
  paymentStatus?: SalePaymentStatus;

  @ApiPropertyOptional({ enum: SaleDeliveryStatus })
  @IsOptional()
  @IsEnum(SaleDeliveryStatus)
  deliveryStatus?: SaleDeliveryStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sellerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  quoteId?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-01',
    description:
      'Fecha de negocio America/Lima, límite inferior inclusivo. El servicio valida confirmedFrom <= confirmedTo.',
  })
  @IsOptional()
  @IsDateOnly()
  confirmedFrom?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-31',
    description: 'Fecha de negocio America/Lima, límite superior inclusivo.',
  })
  @IsOptional()
  @IsDateOnly()
  confirmedTo?: string;

  @ApiPropertyOptional({
    maxLength: 150,
    description:
      'Búsqueda por number/customerName/customerDocumentNumber (insensible a mayúsculas).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  search?: string;
}

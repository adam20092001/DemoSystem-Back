import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { isValidDateOnly } from '../../common/date/business-date';

/**
 * Valida formato Y calendario real (rechaza "2026-02-30",
 * "2026-08-10T10:00:00Z", 29 de febrero no bisiesto), reutilizando
 * isValidDateOnly() del común. Copia local del decorador, mismo criterio ya
 * establecido en el resto del repositorio (Sales/Payments/Quotes/Accounting
 * definen cada uno su propia copia en vez de compartir una entre dominios
 * HTTP distintos): Reports no importa el decorador de ningún otro módulo.
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

/**
 * Base común de paginación + rango de fechas para los 5 reportes nuevos.
 * Herencia de un solo nivel (sin mixins): cada DTO concreto extiende esta
 * clase y agrega únicamente sus propios filtros.
 *
 * `from`/`to` son ambos opcionales e independientes entre sí (un solo lado
 * informado es válido). El significado exacto de la columna filtrada
 * (Sale.confirmedAt, Payment.paidAt o Quote.issueDate) y la técnica de
 * comparación (instante vía startOfBusinessDayUtc/
 * endOfBusinessDayExclusiveUtc, o fecha-only vía toPrismaDate con gte/lte
 * inclusive) dependen de cada reporte y se resuelven en ReportsService, no
 * aquí. La validación `from <= to` también ocurre en el servicio (mismo
 * criterio que QuotesService/SalesService/PaymentsService), porque depende
 * del significado de negocio de cada rango, no de la forma del DTO.
 */
export class ReportDateRangeQueryDto {
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

  @ApiPropertyOptional({
    type: String,
    example: '2026-08-01',
    description:
      'Fecha de negocio America/Lima, límite inferior inclusivo. El servicio valida from <= to.',
  })
  @IsOptional()
  @IsDateOnly()
  from?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-08-31',
    description: 'Fecha de negocio America/Lima, límite superior inclusivo.',
  })
  @IsOptional()
  @IsDateOnly()
  to?: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import {
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { isValidDateOnly } from '../../common/date/business-date';

/**
 * Copia local del decorador (mismo criterio de aislamiento por archivo ya
 * usado en report-date-range-query.dto.ts): Bloque C no modifica ningún
 * archivo de Bloque B salvo defecto real comprobado, así que no se importa
 * el `IsDateOnly` no exportado de ese archivo — se define aquí una segunda
 * copia mínima, idéntica en comportamiento.
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
 * Sin page/limit: el Dashboard no es un listado paginado. La regla
 * "ambos o ninguno" y el default de mes calendario actual America/Lima se
 * resuelven en DashboardService (no aquí): son comportamiento de negocio,
 * no forma del DTO.
 */
export class DashboardQueryDto {
  @ApiPropertyOptional({
    type: String,
    example: '2026-08-01',
    description:
      'Fecha de negocio America/Lima, límite inferior inclusivo. Debe venir junto con `to` (no se admite un solo lado). Si ambos se omiten, el período por defecto es el mes calendario actual America/Lima.',
  })
  @IsOptional()
  @IsDateOnly()
  from?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-08-23',
    description:
      'Fecha de negocio America/Lima, límite superior inclusivo. Debe venir junto con `from`.',
  })
  @IsOptional()
  @IsDateOnly()
  to?: string;
}

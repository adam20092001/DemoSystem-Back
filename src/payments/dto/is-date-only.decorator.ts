import {
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { isValidDateOnly } from '../../common/date/business-date';

/**
 * Valida formato Y calendario real (rechaza "2026-02-30",
 * "2026-08-10T10:00:00Z", 29 de febrero no bisiesto), reutilizando
 * isValidDateOnly() del común en vez de duplicar el algoritmo de fechas.
 * Compartido dentro del propio dominio Payments (list-payments-query.dto.ts
 * y list-receivables-query.dto.ts): evita duplicar el decorador dos veces
 * en el mismo módulo. No se importa desde los DTO de Sales (que definen el
 * suyo localmente, ListSalesQueryDto) ni al revés: cada dominio HTTP define
 * su propia copia, mismo criterio ya establecido para no acoplar capas HTTP
 * entre dominios distintos.
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

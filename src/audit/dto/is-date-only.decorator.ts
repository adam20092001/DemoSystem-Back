import {
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { isValidDateOnly } from '../../common/date/business-date';

/**
 * Copia local del decorador, misma técnica que en Accounting/Payments/Sales:
 * cada dominio HTTP define su propia copia para no acoplar capas HTTP entre
 * dominios distintos. Valida formato Y calendario real (rechaza
 * "2026-02-30", "2026-08-10T10:00:00Z", 29 de febrero no bisiesto)
 * reutilizando isValidDateOnly() del común.
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

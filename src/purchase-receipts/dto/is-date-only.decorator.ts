import {
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { isValidDateOnly } from '../../common/date/business-date';

/**
 * Copia local del decorador (mismo criterio que Payments/Sales/Accounting/
 * Purchase Invoices: cada dominio HTTP define su propia copia para no
 * acoplar capas HTTP entre dominios distintos). Valida formato Y
 * calendario real.
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

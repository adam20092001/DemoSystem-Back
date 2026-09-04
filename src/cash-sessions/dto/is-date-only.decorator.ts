import {
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { isValidDateOnly } from '../../common/date/business-date';

/**
 * Copia local del decorador (mismo criterio ya establecido en el
 * repositorio: cada dominio HTTP define el suyo, ver
 * payments/dto/is-date-only.decorator.ts — nunca se importa entre
 * dominios distintos, para no acoplar capas HTTP). Valida formato Y
 * calendario real (rechaza "2026-02-30", con hora, 29 de febrero no
 * bisiesto).
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

import { ApiProperty } from '@nestjs/swagger';
import { FiscalDocumentType } from '@prisma/client';
import {
  IsEnum,
  IsString,
  Length,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import {
  BOLETA_SERIES_PATTERN,
  FACTURA_SERIES_PATTERN,
} from '../constants/electronic-invoicing.constants';

/**
 * Valida la FORMA de la serie según el documentType YA presente en el mismo
 * DTO (Bloque 11D §4): F + 3 alfanuméricos en mayúscula para FACTURA, B + 3
 * para BOLETA. Nunca normaliza/mayusculiza el valor recibido — un valor
 * inválido simplemente falla, tal como llegó. El servicio/FiscalSeriesService
 * siguen siendo la autoridad final (existencia real, activo/inactivo,
 * agotamiento): esta validación es solo una capa de UX temprana en HTTP.
 */
function IsFiscalSeriesShape(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isFiscalSeriesShape',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (typeof value !== 'string') {
            return false;
          }
          const documentType = (args.object as { documentType?: unknown })
            .documentType;
          if (documentType === FiscalDocumentType.FACTURA) {
            return FACTURA_SERIES_PATTERN.test(value);
          }
          if (documentType === FiscalDocumentType.BOLETA) {
            return BOLETA_SERIES_PATTERN.test(value);
          }
          // documentType inválido/ausente: @IsEnum ya lo reporta por
          // separado. Aquí basta con exigir la forma genérica común a
          // ambos tipos para no dejar `series` sin validar en ese caso.
          return /^[A-Z][A-Z0-9]{3}$/.test(value);
        },
        defaultMessage(): string {
          return (
            'series debe tener exactamente 4 caracteres en mayúscula, con el ' +
            'primer caracter correspondiente al tipo de documento (F... para ' +
            'FACTURA, B... para BOLETA)'
          );
        },
      },
    });
  };
}

/**
 * Body de emisión (Bloque 11D §3/§4): ambos campos SIEMPRE explícitos. El
 * servicio nunca elige automáticamente la primera FiscalSeries activa ni
 * infiere FACTURA/BOLETA a partir del cliente. `saleId` viaja en la ruta,
 * nunca en este body.
 */
export class IssueElectronicDocumentDto {
  @ApiProperty({
    enum: FiscalDocumentType,
    example: FiscalDocumentType.FACTURA,
  })
  @IsEnum(FiscalDocumentType)
  documentType!: FiscalDocumentType;

  @ApiProperty({
    example: 'F001',
    minLength: 4,
    maxLength: 4,
    description:
      'Exactamente 4 caracteres en mayúscula: F... para FACTURA, B... para BOLETA. Nunca se normaliza — un valor inválido falla tal como llegó.',
  })
  @IsString()
  @Length(4, 4)
  @IsFiscalSeriesShape()
  series!: string;
}

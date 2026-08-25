import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * PATCH /configuration/sequences/:documentType (Fase 10, Bloque D).
 * documentType viene exclusivamente del parámetro de ruta (validado con
 * ParseEnumPipe contra DocumentType) — nunca se acepta en el body.
 *
 * prefix: sin regex adicional. El trim/no-blank/máximo 10 caracteres se
 * valida en el servicio (mismo criterio que businessName en
 * ConfigurationService: trim primero, longitud después del trim), porque un
 * @MaxLength() de DTO evaluaría el valor crudo, no el recortado.
 *
 * padding/currentNumber: enteros planos (mismo criterio que
 * quoteValidityDays — @IsInt() + @Min()/@Max(), nunca un string ni una
 * segunda convención numérica). ValidationPipe global tiene
 * enableImplicitConversion:false, así que un número JSON real es
 * obligatorio: un string "6" es rechazado por @IsInt().
 *
 * Al menos un campo debe estar presente: el servicio rechaza un body vacío
 * con 400 antes de abrir transacción.
 */
export class UpdateDocumentSequenceDto {
  @ApiPropertyOptional({
    example: 'COT-',
    description:
      'Se recorta (trim) y no puede quedar en blanco tras el recorte. Máximo 10 caracteres. Se persiste exactamente el valor recortado (sin separador añadido automáticamente).',
  })
  @IsOptional()
  @IsString()
  prefix?: string;

  @ApiPropertyOptional({
    example: 6,
    minimum: 1,
    maximum: 12,
    description: 'Cantidad de dígitos con ceros a la izquierda (1 a 12).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  padding?: number;

  @ApiPropertyOptional({
    example: 150,
    minimum: 0,
    description:
      'Último número emitido. Puede mantenerse igual o avanzar; nunca puede disminuir respecto del valor actual en base de datos (409 si se intenta).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  currentNumber?: number;
}

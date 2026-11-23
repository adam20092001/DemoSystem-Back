import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Forma única de todas las respuestas de error de la API. */
export class ErrorResponseDto {
  @ApiProperty({ example: 404, description: 'Código HTTP de la respuesta' })
  statusCode!: number;

  @ApiProperty({
    example: 'El recurso solicitado no existe',
    description:
      'Mensaje descriptivo. Es un arreglo cuando proviene de la validación de DTOs.',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  })
  message!: string | string[];

  @ApiProperty({ example: 'Not Found', description: 'Etiqueta del error HTTP' })
  error!: string;

  @ApiProperty({
    example: '2026-07-24T22:15:30.123Z',
    description: 'Momento en que se generó el error (ISO 8601)',
  })
  timestamp!: string;

  @ApiProperty({ example: '/api/v1/health', description: 'Ruta solicitada' })
  path!: string;

  @ApiPropertyOptional({
    example: 'ACCOUNT_BLOCKED',
    description:
      'Código estable para que el cliente distinga condiciones específicas ' +
      'sin depender del texto de message. Ausente en la mayoría de errores.',
  })
  code?: string;

  @ApiProperty({
    enum: ['FORM', 'GENERAL'],
    example: 'FORM',
    description:
      'FORM: el error se atribuye a uno o más campos (ver errors). GENERAL: conflicto general sin campo responsable.',
  })
  kind!: 'FORM' | 'GENERAL';

  @ApiPropertyOptional({
    description:
      'Errores por campo. Solo presente cuando kind=FORM. field usa notación de arreglo (lines[0].quantity); type es REQUIRED, FORMAT o BUSINESS.',
    example: [
      {
        field: 'lines[0].quantity',
        code: 'REQUIRED',
        type: 'REQUIRED',
        message: 'quantity should not be empty',
      },
    ],
  })
  errors?: {
    field: string;
    code: string;
    type: 'REQUIRED' | 'FORMAT' | 'BUSINESS';
    message: string;
  }[];
}

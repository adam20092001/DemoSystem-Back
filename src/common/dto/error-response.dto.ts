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
}

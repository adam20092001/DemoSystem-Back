import { ValidationPipe, ValidationPipeOptions } from '@nestjs/common';

/**
 * Opciones de validación de toda la API.
 *
 * - whitelist: descarta propiedades no declaradas en el DTO.
 * - forbidNonWhitelisted: además, rechaza la petición si llegan propiedades extra.
 * - transform: convierte el payload plano en una instancia del DTO.
 * - enableImplicitConversion: false — las conversiones de tipo deben declararse
 *   explícitamente con @Type(), para que no se acepten tipos incorrectos en silencio.
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: {
    enableImplicitConversion: false,
  },
};

/** Se expone como factory para poder verificar la configuración en pruebas. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe(VALIDATION_PIPE_OPTIONS);
}

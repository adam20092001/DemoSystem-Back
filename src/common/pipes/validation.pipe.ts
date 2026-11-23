import {
  ValidationError,
  ValidationPipe,
  ValidationPipeOptions,
} from '@nestjs/common';
import {
  FieldValidationException,
  buildFieldErrors,
} from '../errors/error-contract';

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

/**
 * Pipe con el contrato común de errores (R4): conserva el arreglo `message`
 * de siempre (mismos textos que el pipe estándar de Nest) y añade
 * `code=VALIDATION_ERROR`, `kind=FORM` y `errors[]` con la ruta exacta de
 * cada campo (incluidos arreglos: `lines[0].quantity`).
 */
class ContractValidationPipe extends ValidationPipe {
  override createExceptionFactory(): (
    errors?: ValidationError[],
  ) => unknown {
    return (errors: ValidationError[] = []) =>
      new FieldValidationException(
        this.flattenValidationErrors(errors),
        buildFieldErrors(errors),
      );
  }
}

/** Se expone como factory para poder verificar la configuración en pruebas. */
export function createValidationPipe(): ValidationPipe {
  return new ContractValidationPipe(VALIDATION_PIPE_OPTIONS);
}

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ValidationError,
} from '@nestjs/common';

/**
 * Contrato común de errores (R4). Compatible hacia atrás: el cuerpo conserva
 * statusCode/message/error/timestamp/path (+ code cuando existe) y AÑADE
 * `kind` y `errors[]`. `message` mantiene su tipo (string o arreglo).
 *
 * - kind=FORM: el error se puede atribuir a uno o más campos (errors[] no vacío).
 * - kind=GENERAL: conflicto general sin campo responsable (errors ausente).
 * - type: REQUIRED (falta el dato), FORMAT (tipo/formato inválido) o BUSINESS
 *   (regla de negocio vinculada a un campo).
 */
export type ErrorKind = 'FORM' | 'GENERAL';
export type FieldErrorType = 'REQUIRED' | 'FORMAT' | 'BUSINESS';

export interface ApiFieldError {
  /** Ruta del campo; arreglos con índice: `lines[0].quantity`. */
  field: string;
  /** Código estable en MAYÚSCULAS (p. ej. REQUIRED, INVALID_FORMAT, UNKNOWN_FIELD). */
  code: string;
  type: FieldErrorType;
  message: string;
}

export const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR';

/** Restricciones de class-validator que significan «falta el dato». */
const REQUIRED_CONSTRAINTS = new Set(['isNotEmpty', 'isDefined']);

function joinPath(parent: string, property: string): string {
  if (/^\d+$/.test(property)) {
    return `${parent}[${property}]`;
  }
  return parent === '' ? property : `${parent}.${property}`;
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function toFieldErrors(
  errors: ValidationError[],
  parentPath: string,
  out: ApiFieldError[],
): void {
  for (const error of errors) {
    const path = joinPath(parentPath, error.property);
    const constraints = error.constraints ?? {};
    for (const [constraint, message] of Object.entries(constraints)) {
      if (constraint === 'whitelistValidation') {
        out.push({
          field: path,
          code: 'UNKNOWN_FIELD',
          type: 'FORMAT',
          message,
        });
        continue;
      }
      const required =
        REQUIRED_CONSTRAINTS.has(constraint) || isMissing(error.value);
      out.push({
        field: path,
        code: required ? 'REQUIRED' : 'INVALID_FORMAT',
        type: required ? 'REQUIRED' : 'FORMAT',
        message,
      });
    }
    if (error.children !== undefined && error.children.length > 0) {
      toFieldErrors(error.children, path, out);
    }
  }
}

/** Recorre recursivamente el árbol de errores de class-validator. */
export function buildFieldErrors(errors: ValidationError[]): ApiFieldError[] {
  const out: ApiFieldError[] = [];
  toFieldErrors(errors, '', out);
  return out;
}

/** Excepción de validación de entrada (400): arreglo `message` + errors[] por campo. */
export class FieldValidationException extends BadRequestException {
  constructor(messages: string[], errors: ApiFieldError[]) {
    super({
      message: messages,
      error: 'Bad Request',
      code: VALIDATION_ERROR_CODE,
      kind: 'FORM' satisfies ErrorKind,
      errors,
    });
  }
}

interface BusinessErrorInput {
  message: string;
  /** Código estable de la regla (p. ej. EXCHANGE_RATE_REQUIRED). */
  code: string;
  /** Campo responsable cuando la relación es clara. Omitir para un error general. */
  field?: string;
  type?: FieldErrorType;
}

function structured(input: BusinessErrorInput): Record<string, unknown> {
  if (input.field === undefined) {
    return {
      message: input.message,
      code: input.code,
      kind: 'GENERAL' satisfies ErrorKind,
    };
  }
  return {
    message: input.message,
    code: input.code,
    kind: 'FORM' satisfies ErrorKind,
    errors: [
      {
        field: input.field,
        code: input.code,
        type: input.type ?? 'BUSINESS',
        message: input.message,
      },
    ] satisfies ApiFieldError[],
  };
}

/** 400 por una regla de negocio de entrada, atribuida a un campo. */
export class FieldBadRequestException extends BadRequestException {
  constructor(input: BusinessErrorInput) {
    super(structured(input));
  }
}

/** 409 por una regla de negocio; con `field` se atribuye al campo, sin él es general. */
export class BusinessConflictException extends ConflictException {
  constructor(input: BusinessErrorInput) {
    super(structured(input));
  }
}

/** 404 con código estable. */
export class CodedNotFoundException extends NotFoundException {
  constructor(message: string, code: string) {
    super({ message, code, kind: 'GENERAL' satisfies ErrorKind });
  }
}

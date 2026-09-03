/**
 * Política de código aprobada (Ticket C, plan de implementación C2): 2-30
 * caracteres, primer carácter una letra A-Z, el resto letras/dígitos/guion
 * bajo. Se aplica DESPUÉS de normalizar a mayúsculas (trim + toUpperCase),
 * nunca antes — así "yape" y "YAPE" se evalúan de forma idéntica. Mismo
 * literal que el CHECK `payment_methods_code_format` de
 * migration.sql/20260902213416_expand_payment_methods (Bloque C1): ambas
 * capas deben permanecer sincronizadas si esta política cambia alguna vez.
 */
export const PAYMENT_METHOD_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,29}$/;

/** payment_methods.name VARCHAR(60). */
export const PAYMENT_METHOD_NAME_MAX_LENGTH = 60;

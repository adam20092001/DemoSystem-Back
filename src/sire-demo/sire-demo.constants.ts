/** Identificación obligatoria de toda respuesta del módulo SIRE DEMO. */
export const SIRE_DEMO_MODE = 'DEMO' as const;

/** Versión del formato propio de archivo demostrativo. NO es un layout oficial de SUNAT. */
export const SIRE_DEMO_FORMAT_VERSION = 'DEMO_V1' as const;

export const SIRE_DEMO_DISCLAIMER =
  'Demostración. Sin validez ante SUNAT: no se comunica con SUNAT, no genera tickets, constancias ni códigos CAR, y el formato DEMO_V1 no es un layout oficial.';

/** Límites aprobados (Plan V2) para archivos de propuesta DEMO_V1. */
export const SIRE_DEMO_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SIRE_DEMO_MAX_ROWS = 5000;
export const SIRE_DEMO_MAX_LINE_LENGTH = 1000;
export const SIRE_DEMO_MAX_PARSE_ERRORS = 50;

export const SIRE_DEMO_DEFAULT_PAGE_SIZE = 50;
export const SIRE_DEMO_MAX_PAGE_SIZE = 200;

/** Única moneda soportada. No existe conversión monetaria en esta demo. */
export const SIRE_DEMO_CURRENCY = 'PEN' as const;

/** Token de inyección de los flags ya resueltos del módulo. */
export const SIRE_DEMO_FLAGS = 'SIRE_DEMO_FLAGS';

import { BadRequestException } from '@nestjs/common';
import { SupplierDocumentType } from '@prisma/client';

export const DEFAULT_SUPPLIER_COUNTRY_CODE = 'PE';

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const RUC_PATTERN = /^\d{11}$/;
const DNI_PATTERN = /^\d{8}$/;

/**
 * Trim + mayúsculas, mismo criterio exacto que
 * CustomersService.normalizeDocumentPairForUpdate() — nunca una segunda
 * normalización paralela. La unicidad real (insensible a mayúsculas/
 * espacios) la garantiza el índice único funcional de la migración
 * (`suppliers_document_unique`, UPPER(BTRIM(...))); esta función solo deja
 * el valor persistido ya normalizado para que una lectura directa no
 * necesite volver a aplicar UPPER/BTRIM.
 */
export function normalizeDocumentNumber(raw: string): string {
  if (typeof raw !== 'string') {
    throw new BadRequestException('documentNumber debe ser un texto');
  }
  const trimmed = raw.trim().toUpperCase();
  if (trimmed.length === 0) {
    throw new BadRequestException('documentNumber no puede estar vacío');
  }
  if (trimmed.length > 32) {
    throw new BadRequestException(
      'documentNumber no puede superar los 32 caracteres',
    );
  }
  return trimmed;
}

/**
 * Validación de FORMATO únicamente (longitud/forma numérica) — nunca una
 * verificación real contra el padrón de SUNAT ni ningún servicio externo.
 * RUC/DNI son los únicos tipos con una forma numérica fija conocida; los
 * proveedores extranjeros (FOREIGN_TAX_ID/OTHER) no tienen un formato único
 * entre países, así que solo se exige no-vacío (ya garantizado por
 * normalizeDocumentNumber()) — exigir una forma específica ahí rechazaría
 * identificaciones extranjeras legítimas.
 */
export function assertValidDocumentFormat(
  documentType: SupplierDocumentType,
  normalizedDocumentNumber: string,
): void {
  switch (documentType) {
    case SupplierDocumentType.RUC:
      if (!RUC_PATTERN.test(normalizedDocumentNumber)) {
        throw new BadRequestException(
          'El RUC debe tener exactamente 11 dígitos numéricos',
        );
      }
      return;
    case SupplierDocumentType.DNI:
      if (!DNI_PATTERN.test(normalizedDocumentNumber)) {
        throw new BadRequestException(
          'El DNI debe tener exactamente 8 dígitos numéricos',
        );
      }
      return;
    case SupplierDocumentType.FOREIGN_TAX_ID:
    case SupplierDocumentType.OTHER:
      return;
  }
}

/**
 * `undefined` -> default 'PE' (mismo criterio de default a nivel de
 * servicio que ProductsService/stockMinimum, NR-04 — nunca un
 * `@default` de columna). Siempre valida formato ISO 3166-1 alpha-2,
 * incluido el valor por defecto implícito.
 */
export function normalizeCountryCode(raw: string | undefined): string {
  const value = (raw ?? DEFAULT_SUPPLIER_COUNTRY_CODE).trim().toUpperCase();
  if (!COUNTRY_CODE_PATTERN.test(value)) {
    throw new BadRequestException(
      'countryCode debe ser un código ISO 3166-1 alpha-2 de 2 letras (ej. "PE", "US")',
    );
  }
  return value;
}

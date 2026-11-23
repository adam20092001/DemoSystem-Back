import { Prisma } from '@prisma/client';
import {
  BusinessConflictException,
  FieldBadRequestException,
} from '../common/errors/error-contract';

type CountryDb = Pick<Prisma.TransactionClient, 'country'>;

/** Normaliza un código de país (trim + mayúsculas) y valida el formato de 2 letras. */
export function normalizeCountryCodeInput(
  value: unknown,
  field: string,
): string {
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value.trim())) {
    throw new FieldBadRequestException({
      message: `${field} debe ser un código de país de 2 letras (ISO 3166-1 alpha-2)`,
      code: 'COUNTRY_CODE_FORMAT',
      field,
      type: 'FORMAT',
    });
  }
  return value.trim().toUpperCase();
}

/**
 * Exige que el país exista en el catálogo compartido y esté ACTIVO. Se usa al
 * ASIGNAR un país (alta de proveedor/operación o cambio de su país): un valor
 * que no cambia no se revalida, para que un país desactivado después no
 * impida editar documentos históricos que ya lo usan.
 */
export async function assertCountryUsable(
  db: CountryDb,
  code: string,
  field: string,
): Promise<void> {
  const country = await db.country.findUnique({
    where: { code },
    select: { active: true },
  });
  if (country === null) {
    throw new FieldBadRequestException({
      message: `El país ${code} no existe en el catálogo de países`,
      code: 'COUNTRY_NOT_FOUND',
      field,
    });
  }
  if (!country.active) {
    throw new BusinessConflictException({
      message: `El país ${code} está inactivo y no puede asignarse a documentos nuevos`,
      code: 'COUNTRY_INACTIVE',
      field,
    });
  }
}

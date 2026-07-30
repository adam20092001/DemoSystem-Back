import { Prisma } from '@prisma/client';
import { SafeUnit } from '../types/safe-unit';

/** Select explícito: única fuente de verdad de qué sale hacia el dominio. */
export const UNIT_SAFE_SELECT = {
  id: true,
  code: true,
  name: true,
  abbreviation: true,
  allowDecimal: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UnitSelect;

export type UnitRow = Prisma.UnitGetPayload<{
  select: typeof UNIT_SAFE_SELECT;
}>;

export function toSafeUnit(unit: UnitRow): SafeUnit {
  return {
    id: unit.id,
    code: unit.code,
    name: unit.name,
    abbreviation: unit.abbreviation,
    allowDecimal: unit.allowDecimal,
    status: unit.status,
    createdAt: unit.createdAt,
    updatedAt: unit.updatedAt,
  };
}

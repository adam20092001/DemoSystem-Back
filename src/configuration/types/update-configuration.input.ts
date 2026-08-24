import { RoleName } from '@prisma/client';

/**
 * Bloque A: solo campos de identidad y moneda. Los campos `| null` aceptan
 * null explícito (limpiar el valor) además de undefined (no tocar), mismo
 * criterio que UpdateCategoryInput. businessName nunca acepta null: es
 * NOT NULL en el esquema.
 *
 * requesterRole es el rol del actor autenticado (defensa en profundidad a
 * nivel de servicio, independiente de @Roles()/RolesGuard).
 */
export interface UpdateConfigurationInput {
  businessName?: string;
  tradeName?: string | null;
  taxId?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  currencyCode?: string;
  currencySymbol?: string;
  actorUserId: string;
  ipAddress?: string | null;
  requesterRole: RoleName;
}

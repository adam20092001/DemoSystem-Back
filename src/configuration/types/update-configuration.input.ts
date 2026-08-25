import { RoleName } from '@prisma/client';

/**
 * Bloque A: campos de identidad y moneda. Bloque B (Fase 10): se agregan
 * quoteValidityDays/maxDiscountPercent. Los campos `| null` aceptan null
 * explícito (limpiar el valor) además de undefined (no tocar), mismo
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
  quoteValidityDays?: number;
  /** Decimal como texto, nunca number de JavaScript. */
  maxDiscountPercent?: string;
  actorUserId: string;
  ipAddress?: string | null;
  requesterRole: RoleName;
}

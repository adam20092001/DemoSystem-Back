import { Prisma } from '@prisma/client';
import { SafeCompanySettings } from '../types/safe-company-settings';
import { SafePosCompanySettings } from '../types/safe-pos-company-settings';

/** Select explícito: única fuente de verdad de qué sale hacia el dominio HTTP. */
export const COMPANY_SETTINGS_SAFE_SELECT = {
  id: true,
  businessName: true,
  tradeName: true,
  taxId: true,
  address: true,
  phone: true,
  email: true,
  currencyCode: true,
  currencySymbol: true,
  taxEnabled: true,
  taxRate: true,
  quoteValidityDays: true,
  maxDiscountPercent: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CompanySettingsSelect;

export type CompanySettingsRow = Prisma.CompanySettingsGetPayload<{
  select: typeof COMPANY_SETTINGS_SAFE_SELECT;
}>;

export function toSafeCompanySettings(
  row: CompanySettingsRow,
): SafeCompanySettings {
  return {
    id: row.id,
    businessName: row.businessName,
    tradeName: row.tradeName,
    taxId: row.taxId,
    address: row.address,
    phone: row.phone,
    email: row.email,
    currencyCode: row.currencyCode,
    currencySymbol: row.currencySymbol,
    taxEnabled: row.taxEnabled,
    taxRate: row.taxRate.toFixed(2),
    quoteValidityDays: row.quoteValidityDays,
    maxDiscountPercent: row.maxDiscountPercent.toFixed(2),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Select explícito del surface POS (Ticket A post-MVP, GET
 * /api/v1/configuration/pos): SOLO los 9 campos aprobados. Nunca se pide el
 * registro completo para luego ocultar campos en la respuesta — un campo
 * administrativo agregado a COMPANY_SETTINGS_SAFE_SELECT en el futuro (p.
 * ej. phone/email/uno nuevo) nunca llega siquiera a esta consulta.
 */
export const COMPANY_SETTINGS_POS_SAFE_SELECT = {
  businessName: true,
  tradeName: true,
  taxId: true,
  address: true,
  currencyCode: true,
  currencySymbol: true,
  taxEnabled: true,
  taxRate: true,
  maxDiscountPercent: true,
} satisfies Prisma.CompanySettingsSelect;

export type PosCompanySettingsRow = Prisma.CompanySettingsGetPayload<{
  select: typeof COMPANY_SETTINGS_POS_SAFE_SELECT;
}>;

export function toSafePosCompanySettings(
  row: PosCompanySettingsRow,
): SafePosCompanySettings {
  return {
    businessName: row.businessName,
    tradeName: row.tradeName,
    taxId: row.taxId,
    address: row.address,
    currencyCode: row.currencyCode,
    currencySymbol: row.currencySymbol,
    taxEnabled: row.taxEnabled,
    taxRate: row.taxRate.toFixed(2),
    maxDiscountPercent: row.maxDiscountPercent.toFixed(2),
  };
}

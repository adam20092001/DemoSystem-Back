import { Prisma } from '@prisma/client';
import { SafeCompanySettings } from '../types/safe-company-settings';

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

import { Prisma } from '@prisma/client';

/**
 * Forma de dominio devuelta por SettingsReader al resto del sistema
 * (Cotizaciones/Ventas, Bloques B/C). A diferencia de SafeCompanySettings
 * (HTTP), conserva Prisma.Decimal sin convertir a string: el llamador hará
 * aritmética exacta con estos valores (nunca Number()/parseFloat()).
 * Deliberadamente estrecho: no incluye ningún campo de identidad de la
 * empresa (businessName/tradeName/taxId/address/phone/email).
 */
export interface CompanySettingsSnapshot {
  currencyCode: string;
  currencySymbol: string;
  taxEnabled: boolean;
  taxRate: Prisma.Decimal;
  quoteValidityDays: number;
  maxDiscountPercent: Prisma.Decimal;
}

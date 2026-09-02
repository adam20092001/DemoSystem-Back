/**
 * Forma segura de CompanySettings expuesta por el surface de solo lectura
 * para POS (GET /api/v1/configuration/pos, Ticket A post-MVP). Deliberadamente
 * DISTINTA de SafeCompanySettings: contiene exactamente los 9 campos que el
 * POS necesita, nunca el registro administrativo completo — así un campo
 * agregado en el futuro a CompanySettings/SafeCompanySettings (p. ej.
 * administrativo, no pensado para SELLER) no se filtra automáticamente a
 * este contrato solo por compartir el mismo modelo de origen. Decimal
 * siempre como string de 2 decimales (taxRate/maxDiscountPercent), mismo
 * criterio que SafeCompanySettings. Sin id/phone/email/quoteValidityDays/
 * createdAt/updatedAt: fuera del alcance aprobado para POS (ver plan de
 * implementación de Ticket A).
 */
export interface SafePosCompanySettings {
  businessName: string;
  tradeName: string | null;
  taxId: string | null;
  address: string | null;
  currencyCode: string;
  currencySymbol: string;
  taxEnabled: boolean;
  taxRate: string;
  maxDiscountPercent: string;
}

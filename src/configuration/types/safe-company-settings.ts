/**
 * Forma segura de CompanySettings expuesta por la API (GET/PATCH
 * /api/v1/configuration). Decimal siempre como string de 2 decimales
 * (taxRate/maxDiscountPercent), mismo criterio que el resto del dominio.
 * `singleton` nunca se expone: es un detalle de implementación interno.
 */
export interface SafeCompanySettings {
  id: string;
  businessName: string;
  tradeName: string | null;
  taxId: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  currencyCode: string;
  currencySymbol: string;
  /** Bloque C: expuesto en modo lectura, aún no editable por PATCH en el Bloque A. */
  taxEnabled: boolean;
  /** Bloque C: expuesto en modo lectura, aún no editable por PATCH en el Bloque A. */
  taxRate: string;
  /** Bloque B: expuesto en modo lectura, aún no editable por PATCH en el Bloque A. */
  quoteValidityDays: number;
  /** Bloque B: expuesto en modo lectura, aún no editable por PATCH en el Bloque A. */
  maxDiscountPercent: string;
  createdAt: Date;
  updatedAt: Date;
}

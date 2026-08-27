import { CustomerDocumentType, Prisma, SaleStatus } from '@prisma/client';

/** Ítem congelado de Sale, tal como lo necesita el snapshot fiscal (Bloque 11C §14). */
export interface SaleFiscalSnapshotItem {
  productSku: string;
  productName: string;
  unitCode: string;
  unitName: string;
  unitAbbreviation: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

/**
 * Lectura estrecha de Sale + SaleItem (Bloque 11C §6/§11/§13/§14): SOLO los
 * campos que ElectronicDocumentsService.issue() necesita para validar y
 * copiar. Nunca se relee Customer/Product en vivo ni CompanySettings para
 * moneda/impuesto — currencyCode/subtotal/discountAmount/taxAmount/total ya
 * son el snapshot congelado de la venta (Fase 11, Bloque B).
 */
export interface SaleFiscalSnapshot {
  id: string;
  number: string;
  status: SaleStatus;

  customerIsGeneric: boolean;
  customerDocumentType: CustomerDocumentType | null;
  customerDocumentNumber: string | null;
  customerName: string;
  customerAddress: string | null;

  subtotal: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
  currencyCode: string;

  items: SaleFiscalSnapshotItem[];
}

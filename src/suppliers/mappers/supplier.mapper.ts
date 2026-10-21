import { Prisma } from '@prisma/client';
import { SafeSupplier } from '../types/safe-supplier';

/** Única fuente de verdad para la forma segura de Supplier expuesta hacia afuera. */
export const SUPPLIER_SAFE_SELECT = {
  id: true,
  documentType: true,
  documentNumber: true,
  countryCode: true,
  legalName: true,
  tradeName: true,
  contactName: true,
  phone: true,
  email: true,
  address: true,
  internalNotes: true,
  defaultCurrencyCode: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SupplierSelect;

export type SupplierSafeRow = Prisma.SupplierGetPayload<{
  select: typeof SUPPLIER_SAFE_SELECT;
}>;

export function toSafeSupplier(row: SupplierSafeRow): SafeSupplier {
  return {
    id: row.id,
    documentType: row.documentType,
    documentNumber: row.documentNumber,
    countryCode: row.countryCode,
    legalName: row.legalName,
    tradeName: row.tradeName,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    address: row.address,
    internalNotes: row.internalNotes,
    defaultCurrencyCode: row.defaultCurrencyCode,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

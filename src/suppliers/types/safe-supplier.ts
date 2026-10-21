import { SupplierDocumentType, SupplierStatus } from '@prisma/client';

/** Respuesta segura de Supplier (sin campos internos ni de otras fases). */
export interface SafeSupplier {
  id: string;
  documentType: SupplierDocumentType;
  documentNumber: string;
  countryCode: string;
  legalName: string;
  tradeName: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  internalNotes: string | null;
  defaultCurrencyCode: string | null;
  status: SupplierStatus;
  createdAt: Date;
  updatedAt: Date;
}

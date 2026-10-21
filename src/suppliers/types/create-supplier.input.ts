import { SupplierDocumentType } from '@prisma/client';

/**
 * No expone id, status ni createdAt/updatedAt: son valores de sistema
 * fijados por SuppliersService, nunca controlados por el llamador.
 * countryCode es opcional: SuppliersService aplica 'PE' por defecto cuando
 * se omite.
 */
export interface CreateSupplierInput {
  documentType: SupplierDocumentType;
  documentNumber: string;
  countryCode?: string;
  legalName: string;
  tradeName?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  address?: string;
  internalNotes?: string;
  defaultCurrencyCode?: string;
  actorUserId: string;
  ipAddress?: string | null;
}

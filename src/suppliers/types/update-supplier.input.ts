import { SupplierDocumentType } from '@prisma/client';

/**
 * status es inmutable desde update() (cambia solo por activate()/
 * deactivate()). documentType/documentNumber son un par lógico: ambos deben
 * llegar explícitamente presentes, o ninguno — a diferencia de
 * UpdateCustomerInput, aquí no existe "ambos null limpia el par": un
 * proveedor siempre exige documento, así que no hay forma válida de
 * vaciarlo.
 */
export interface UpdateSupplierInput {
  supplierId: string;
  documentType?: SupplierDocumentType;
  documentNumber?: string;
  countryCode?: string;
  legalName?: string;
  tradeName?: string | null;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  internalNotes?: string | null;
  defaultCurrencyCode?: string | null;
  actorUserId: string;
  ipAddress?: string | null;
}

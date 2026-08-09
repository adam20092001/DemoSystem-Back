import {
  CustomerDocumentType,
  CustomerStage,
  CustomerStatus,
  CustomerType,
} from '@prisma/client';

/** Respuesta segura de Customer (sin campos internos ni de otras fases). */
export interface SafeCustomer {
  id: string;
  code: string | null;
  customerType: CustomerType | null;
  customerStage: CustomerStage;
  documentType: CustomerDocumentType | null;
  documentNumber: string | null;
  name: string;
  tradeName: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  internalNotes: string | null;
  isGeneric: boolean;
  status: CustomerStatus;
  createdAt: Date;
  updatedAt: Date;
}

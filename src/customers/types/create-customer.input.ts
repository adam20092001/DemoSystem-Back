import {
  CustomerDocumentType,
  CustomerStage,
  CustomerType,
} from '@prisma/client';

/**
 * Solo cubre la creación de clientes normales. El cliente genérico "Público
 * general" no se crea a través de este input: es exclusivo del seed
 * protegido (Fase 4, Bloque A). No expone id, code, isGeneric ni status:
 * son valores de sistema, nunca controlados por el llamador.
 */
export interface CreateCustomerInput {
  customerType: CustomerType;
  customerStage: CustomerStage;
  name: string;
  documentType?: CustomerDocumentType;
  documentNumber?: string;
  tradeName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  address?: string;
  internalNotes?: string;
  actorUserId: string;
  ipAddress?: string | null;
}

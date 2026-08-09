import { CustomerDocumentType } from '@prisma/client';

/**
 * No expone code, customerType, customerStage, status ni isGeneric: esos
 * campos son inmutables desde update() (customerType/code/isGeneric para
 * siempre; customerStage y status cambian solo por sus métodos de ciclo de
 * vida dedicados). documentType/documentNumber son un par lógico: ambos
 * deben llegar explícitamente presentes (o ninguno) — undefined = no tocar
 * el par completo, null = limpiarlo, valor = reemplazarlo.
 */
export interface UpdateCustomerInput {
  customerId: string;
  name?: string;
  documentType?: CustomerDocumentType | null;
  documentNumber?: string | null;
  tradeName?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  internalNotes?: string | null;
  actorUserId: string;
  ipAddress?: string | null;
}

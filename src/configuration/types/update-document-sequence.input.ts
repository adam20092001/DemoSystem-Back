import { DocumentType, RoleName } from '@prisma/client';

/**
 * Entrada interna de SequenceAdminService.updateSequence(), análoga a
 * UpdateConfigurationInput: nunca se construye a partir del body crudo de la
 * petición sin pasar antes por UpdateDocumentSequenceDto (validación) y por
 * el controller (documentType viene del parámetro de ruta, nunca del body).
 */
export interface UpdateDocumentSequenceInput {
  documentType: DocumentType;
  prefix?: string;
  padding?: number;
  currentNumber?: number;
  actorUserId: string;
  ipAddress: string | null;
  requesterRole: RoleName;
}

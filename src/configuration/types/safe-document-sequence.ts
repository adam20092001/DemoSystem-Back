import { DocumentType } from '@prisma/client';

/**
 * Forma segura de un DocumentSequence expuesta por la administración de
 * secuencias (Fase 10, Bloque D). Nunca expone ningún método/valor de
 * generación (no existe "próximo número" en esta forma): currentNumber es
 * exactamente el último número emitido, el mismo significado que usa
 * DocumentSequenceService.next() internamente.
 */
export interface SafeDocumentSequence {
  id: string;
  documentType: DocumentType;
  prefix: string;
  padding: number;
  currentNumber: number;
  updatedAt: Date;
}

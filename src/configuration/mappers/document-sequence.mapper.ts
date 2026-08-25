import { Prisma } from '@prisma/client';
import { SafeDocumentSequence } from '../types/safe-document-sequence';

/** Select explícito: única fuente de verdad de qué sale hacia el dominio HTTP. */
export const DOCUMENT_SEQUENCE_SAFE_SELECT = {
  id: true,
  documentType: true,
  prefix: true,
  padding: true,
  currentNumber: true,
  updatedAt: true,
} satisfies Prisma.DocumentSequenceSelect;

export type DocumentSequenceRow = Prisma.DocumentSequenceGetPayload<{
  select: typeof DOCUMENT_SEQUENCE_SAFE_SELECT;
}>;

export function toSafeDocumentSequence(
  row: DocumentSequenceRow,
): SafeDocumentSequence {
  return {
    id: row.id,
    documentType: row.documentType,
    prefix: row.prefix,
    padding: row.padding,
    currentNumber: row.currentNumber,
    updatedAt: row.updatedAt,
  };
}

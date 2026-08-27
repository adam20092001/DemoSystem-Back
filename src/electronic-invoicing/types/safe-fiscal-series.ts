import { FiscalDocumentType } from '@prisma/client';

/**
 * Forma segura de descubrimiento de series (Bloque 11D §22): nunca
 * `nextNumber` — con emisión concurrente, cualquier "próximo número"
 * mostrado podría quedar obsoleto de inmediato. currentNumber es
 * puramente informativo (último número YA emitido).
 */
export interface SafeFiscalSeries {
  id: string;
  documentType: FiscalDocumentType;
  series: string;
  currentNumber: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

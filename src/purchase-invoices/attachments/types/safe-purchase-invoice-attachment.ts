import { PurchaseInvoiceAttachmentStatus } from '@prisma/client';

/** Metadatos públicos de un adjunto. NUNCA incluyen la clave de almacenamiento ni rutas. */
export interface SafePurchaseInvoiceAttachment {
  id: string;
  purchaseInvoiceId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  uploadedAt: Date;
  uploadedByUserId: string;
  status: PurchaseInvoiceAttachmentStatus;
  /** true solo mientras la factura está en borrador. */
  canDelete: boolean;
  /** Los tres formatos permitidos admiten previsualización autenticada. */
  previewable: boolean;
  /** true cuando la respuesta es el resultado de una carga previa (misma Idempotency-Key). */
  idempotentReplay: boolean;
}

import { ImportReceiptLinkStatus } from '@prisma/client';

interface SafeImportReceiptLinkActor {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

/** Respuesta segura de ImportReceiptLink (Fase B3). */
export interface SafeImportReceiptLink {
  id: string;
  importShipmentLineId: string;
  purchaseReceiptLineId: string;
  linkedQuantity: string;
  status: ImportReceiptLinkStatus;
  createdBy: SafeImportReceiptLinkActor;
  createdAt: Date;
  cancelledAt: Date | null;
  cancelledBy: SafeImportReceiptLinkActor | null;
  cancellationReason: string | null;
}

/** DRAFT local al dominio: estado de recepción DERIVADO, nunca persistido (Fase B3). */
export type ShipmentLineReceptionStatus =
  'PENDING' | 'PARTIALLY_RECEIVED' | 'FULLY_RECEIVED';

export interface SafeShipmentLineReceptionSummary {
  importShipmentLineId: string;
  shippedQuantity: string;
  linkedReceivedQuantity: string;
  remainingQuantity: string;
  receptionStatus: ShipmentLineReceptionStatus;
  links: SafeImportReceiptLink[];
}

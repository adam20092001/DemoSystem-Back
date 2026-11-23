import { ImportOperationStatus, ImportShipmentStatus } from '@prisma/client';
import { SafePurchaseReceipt } from '../../purchase-receipts/types/safe-purchase-receipt';
import { SafeImportOperation } from './safe-import-operation';
import { SafeImportReceiptLink } from './safe-import-receipt-link';

/**
 * Cantidades de una línea de embarque, con definiciones EXPLÍCITAS y distintas
 * (nunca se asume que el pendiente de la factura es el de una importación):
 *  - invoicedQuantity: cantidad facturada de la línea de factura.
 *  - assignedToShipmentsQuantity: suma de cantidades planificadas de TODAS las
 *    líneas de embarque no canceladas (de cualquier importación) que usan esa
 *    línea de factura.
 *  - receivedQuantity: suma de recepciones de compra ACTIVE de esa línea de
 *    factura, vengan de Compras o de Importaciones.
 *  - shipmentLineQuantity: cantidad embarcada de ESTA línea.
 *  - linkedQuantity: parte de esa línea de embarque ya vinculada (vínculos ACTIVE)
 *    a mercadería recibida.
 *  - pendingQuantity: cantidad de ESTA línea de embarque aún sin recibir/vincular
 *    (shipmentLineQuantity − linkedQuantity, nunca negativa).
 *  - invoicePendingReceivableQuantity: facturado − recibido en toda la factura.
 *  - maxReceivableNow: lo máximo que puede recibirse hoy desde esta línea =
 *    min(pendingQuantity, invoicePendingReceivableQuantity).
 */
export interface ImportReceivingCandidateReceiptLine {
  purchaseReceiptLineId: string;
  purchaseReceiptId: string;
  receivedDate: string;
  receivedQuantity: string;
  linkedElsewhereQuantity: string;
  /** Parte de esa línea recibida aún no vinculada a ningún embarque. */
  availableToLinkQuantity: string;
}

export interface ImportReceivingLineSummary {
  importShipmentLineId: string;
  productId: string | null;
  sku: string | null;
  description: string;
  unitCode: string | null;
  purchaseInvoiceLineId: string | null;
  isReceivable: boolean;
  invoicedQuantity: string | null;
  assignedToShipmentsQuantity: string | null;
  receivedQuantity: string | null;
  shipmentLineQuantity: string;
  linkedQuantity: string;
  pendingQuantity: string;
  invoicePendingReceivableQuantity: string | null;
  maxReceivableNow: string;
  candidateReceiptLines: ImportReceivingCandidateReceiptLine[];
}

export interface ImportReceivingShipmentSummary {
  importShipmentId: string;
  status: ImportShipmentStatus;
  canReceive: boolean;
  lines: ImportReceivingLineSummary[];
}

export interface ImportReceivingSummary {
  importOperationId: string;
  reference: string;
  status: ImportOperationStatus;
  purchaseInvoiceId: string | null;
  purchaseInvoiceStatus: string | null;
  isLegacyUnlinked: boolean;
  /** Se puede registrar una recepción (operación IN_PROGRESS, factura CONFIRMED y vinculada). */
  canReceive: boolean;
  /** Razón por la que no se puede recibir; null si canReceive. */
  cannotReceiveReason: string | null;
  /** Cantidad pendiente total (líneas recibibles de embarques no cancelados). */
  pendingQuantityTotal: string;
  /** Se cumplen hoy todas las condiciones de cierre (sin hacer nada). */
  canComplete: boolean;
  cannotCompleteReason: string | null;
  shipments: ImportReceivingShipmentSummary[];
}

export interface ImportReceivingResult {
  requestId: string;
  /** true cuando se devolvió el resultado original de una solicitud con la misma Idempotency-Key. */
  idempotentReplay: boolean;
  mode: 'RECEIVE' | 'LINK_EXISTING';
  /** La recepción creada (solo modo RECEIVE). */
  receipt: SafePurchaseReceipt | null;
  links: SafeImportReceiptLink[];
  operationCompleted: boolean;
  operation: SafeImportOperation;
}

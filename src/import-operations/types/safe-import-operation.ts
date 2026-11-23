import {
  ImportOperationStatus,
  PurchaseInvoiceDocumentType,
  PurchaseInvoiceStatus,
  SupplierDocumentType,
} from '@prisma/client';

interface SafeImportOperationActor {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

/** Proveedor heredado de la factura vinculada (nunca editable desde la operación). */
export interface SafeLinkedSupplier {
  id: string;
  legalName: string;
  documentType: SupplierDocumentType;
  documentNumber: string;
  countryCode: string;
}

/** Resumen de la factura de compra principal de la operación (R4). */
export interface SafeLinkedPurchaseInvoice {
  id: string;
  documentType: PurchaseInvoiceDocumentType;
  documentSeries: string | null;
  documentNumber: string;
  /** Serie-número legible, p. ej. «F001-123». */
  documentLabel: string;
  status: PurchaseInvoiceStatus;
  /** Moneda del documento de compra. */
  currencyCode: string;
  /** true solo con la factura CONFIRMED: recién entonces se asignan líneas a embarques. */
  canAssignLines: boolean;
  supplier: SafeLinkedSupplier;
}

/**
 * Línea de la compra con su disponibilidad logística. Todas las cantidades
 * son strings decimales (3 decimales) en la unidad de la línea.
 */
export interface SafeImportInvoiceLine {
  purchaseInvoiceLineId: string;
  productId: string | null;
  productSku: string | null;
  description: string;
  unitCode: string | null;
  invoicedQuantity: string;
  /** Asignada a embarques NO anulados, de TODAS las operaciones. */
  assignedQuantity: string;
  /** Asignada a embarques no anulados de ESTA operación. */
  assignedToThisOperationQuantity: string;
  /** Todavía asignable: facturada − asignada. */
  availableQuantity: string;
  /** Recibida físicamente (recepciones ACTIVE). */
  receivedQuantity: string;
  /** Facturada − recibida. */
  pendingReceiptQuantity: string;
}

/** Respuesta segura de ImportOperation (Fase B1; ampliada en R4). */
export interface SafeImportOperation {
  id: string;
  /** Generada por el servidor (IMP-AAAA-NNNNNN) en operaciones nuevas. */
  reference: string;
  description: string | null;
  originCountry: string;
  destinationCountry: string;
  status: ImportOperationStatus;
  externalReference: string | null;
  notes: string | null;
  /** Factura principal. null solo en operaciones históricas (isLegacyUnlinked). */
  purchaseInvoiceId: string | null;
  isLegacyUnlinked: boolean;
  purchaseInvoice: SafeLinkedPurchaseInvoice | null;
  /** Solo en el detalle; null en listados. */
  invoiceLines: SafeImportInvoiceLine[] | null;
  createdBy: SafeImportOperationActor;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  completedBy: SafeImportOperationActor | null;
  cancelledAt: Date | null;
  cancelledBy: SafeImportOperationActor | null;
  cancellationReason: string | null;
  shipmentCount: number;
}

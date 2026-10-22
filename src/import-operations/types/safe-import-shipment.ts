import { ImportShipmentStatus, ImportTransportMode } from '@prisma/client';

interface SafeImportShipmentActor {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

export interface SafeImportShipmentLine {
  id: string;
  productId: string | null;
  descriptionSnapshot: string;
  plannedQuantity: string;
  unitCode: string | null;
  unitName: string | null;
  weightValue: string | null;
  weightUnit: string | null;
  volumeValue: string | null;
  volumeUnit: string | null;
  purchaseInvoiceLineId: string | null;
}

/** Respuesta segura de ImportShipment (Fase B1), con sus líneas. */
export interface SafeImportShipment {
  id: string;
  importOperationId: string;
  transportMode: ImportTransportMode;
  carrierName: string | null;
  trackingReference: string | null;
  billOfLadingNumber: string | null;
  containerReference: string | null;
  originLocation: string | null;
  destinationLocation: string | null;
  estimatedDepartureDate: string | null;
  actualDepartureDate: string | null;
  estimatedArrivalDate: string | null;
  actualArrivalDate: string | null;
  status: ImportShipmentStatus;
  notes: string | null;
  createdBy: SafeImportShipmentActor;
  createdAt: Date;
  updatedAt: Date;
  cancelledAt: Date | null;
  cancelledBy: SafeImportShipmentActor | null;
  cancellationReason: string | null;
  lines: SafeImportShipmentLine[];
}

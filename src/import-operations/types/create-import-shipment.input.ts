import { ImportTransportMode } from '@prisma/client';
import { ImportShipmentLineInput } from './import-shipment-line.input';

/** Comando interno de ImportShipmentsService.create() — no es un DTO HTTP. */
export interface CreateImportShipmentInput {
  importOperationId: string;
  transportMode: ImportTransportMode;
  carrierName?: string;
  trackingReference?: string;
  billOfLadingNumber?: string;
  containerReference?: string;
  originLocation?: string;
  destinationLocation?: string;
  estimatedDepartureDate?: string;
  estimatedArrivalDate?: string;
  notes?: string;
  lines: ImportShipmentLineInput[];
  actorUserId: string;
  ipAddress: string | null;
}

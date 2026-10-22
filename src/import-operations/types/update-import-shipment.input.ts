import { ImportTransportMode } from '@prisma/client';
import { ImportShipmentLineInput } from './import-shipment-line.input';

/**
 * Comando interno de ImportShipmentsService.update() — no es un DTO HTTP.
 * Solo permitido mientras el embarque está PLANNED (CLAUDE.md B1 §2/§3:
 * "editable planning state"). `lines`, si se provee, REEMPLAZA el arreglo
 * completo — nunca un parche línea a línea.
 */
export interface UpdateImportShipmentInput {
  importShipmentId: string;
  transportMode?: ImportTransportMode;
  carrierName?: string | null;
  trackingReference?: string | null;
  billOfLadingNumber?: string | null;
  containerReference?: string | null;
  originLocation?: string | null;
  destinationLocation?: string | null;
  estimatedDepartureDate?: string | null;
  estimatedArrivalDate?: string | null;
  notes?: string | null;
  lines?: ImportShipmentLineInput[];
  actorUserId: string;
  ipAddress: string | null;
}

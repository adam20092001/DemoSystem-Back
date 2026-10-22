/** Comando interno de ImportShipmentsService.depart() — no es un DTO HTTP. */
export interface DepartImportShipmentInput {
  importShipmentId: string;
  actualDepartureDate?: string;
  actorUserId: string;
  ipAddress: string | null;
}

/** Comando interno de ImportShipmentsService.arrive() — no es un DTO HTTP. */
export interface ArriveImportShipmentInput {
  importShipmentId: string;
  actualArrivalDate?: string;
  actorUserId: string;
  ipAddress: string | null;
}

/** Comando interno de ImportShipmentsService.cancel() — no es un DTO HTTP. */
export interface CancelImportShipmentInput {
  importShipmentId: string;
  reason: string;
  actorUserId: string;
  ipAddress: string | null;
}

import { Prisma } from '@prisma/client';

/** Fila bloqueada (`FOR UPDATE`) de import_shipment_lines + su embarque, para la asignación de gastos (Fase B2). */
export interface LockedShipmentLineForAllocationRow {
  id: string;
  plannedQuantity: Prisma.Decimal;
  weightValue: Prisma.Decimal | null;
  volumeValue: Prisma.Decimal | null;
  shipmentStatus: string;
  importOperationId: string;
}

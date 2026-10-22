import { Prisma } from '@prisma/client';
import { fromPrismaDate } from '../../common/date/business-date';
import { SafeImportShipment } from '../types/safe-import-shipment';

const ACTOR_SUMMARY_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

const LINE_SELECT = {
  id: true,
  productId: true,
  descriptionSnapshot: true,
  plannedQuantity: true,
  unitCode: true,
  unitName: true,
  weightValue: true,
  weightUnit: true,
  volumeValue: true,
  volumeUnit: true,
  purchaseInvoiceLineId: true,
} satisfies Prisma.ImportShipmentLineSelect;

export const IMPORT_SHIPMENT_SAFE_SELECT = {
  id: true,
  importOperationId: true,
  transportMode: true,
  carrierName: true,
  trackingReference: true,
  billOfLadingNumber: true,
  containerReference: true,
  originLocation: true,
  destinationLocation: true,
  estimatedDepartureDate: true,
  actualDepartureDate: true,
  estimatedArrivalDate: true,
  actualArrivalDate: true,
  status: true,
  notes: true,
  createdBy: { select: ACTOR_SUMMARY_SELECT },
  createdAt: true,
  updatedAt: true,
  cancelledAt: true,
  cancelledBy: { select: ACTOR_SUMMARY_SELECT },
  cancellationReason: true,
  lines: { select: LINE_SELECT, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.ImportShipmentSelect;

export type ImportShipmentSafeRow = Prisma.ImportShipmentGetPayload<{
  select: typeof IMPORT_SHIPMENT_SAFE_SELECT;
}>;

function toDateOnly(value: Date | null): string | null {
  return value === null ? null : fromPrismaDate(value);
}

export function toSafeImportShipment(
  row: ImportShipmentSafeRow,
): SafeImportShipment {
  return {
    id: row.id,
    importOperationId: row.importOperationId,
    transportMode: row.transportMode,
    carrierName: row.carrierName,
    trackingReference: row.trackingReference,
    billOfLadingNumber: row.billOfLadingNumber,
    containerReference: row.containerReference,
    originLocation: row.originLocation,
    destinationLocation: row.destinationLocation,
    estimatedDepartureDate: toDateOnly(row.estimatedDepartureDate),
    actualDepartureDate: toDateOnly(row.actualDepartureDate),
    estimatedArrivalDate: toDateOnly(row.estimatedArrivalDate),
    actualArrivalDate: toDateOnly(row.actualArrivalDate),
    status: row.status,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy,
    cancellationReason: row.cancellationReason,
    lines: row.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      descriptionSnapshot: line.descriptionSnapshot,
      plannedQuantity: line.plannedQuantity.toFixed(3),
      unitCode: line.unitCode,
      unitName: line.unitName,
      weightValue: line.weightValue?.toFixed(3) ?? null,
      weightUnit: line.weightUnit,
      volumeValue: line.volumeValue?.toFixed(3) ?? null,
      volumeUnit: line.volumeUnit,
      purchaseInvoiceLineId: line.purchaseInvoiceLineId,
    })),
  };
}

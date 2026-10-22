import { Prisma } from '@prisma/client';
import { SafeImportOperation } from '../types/safe-import-operation';

const ACTOR_SUMMARY_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

export const IMPORT_OPERATION_SAFE_SELECT = {
  id: true,
  reference: true,
  description: true,
  originCountry: true,
  destinationCountry: true,
  status: true,
  externalReference: true,
  notes: true,
  createdBy: { select: ACTOR_SUMMARY_SELECT },
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  completedBy: { select: ACTOR_SUMMARY_SELECT },
  cancelledAt: true,
  cancelledBy: { select: ACTOR_SUMMARY_SELECT },
  cancellationReason: true,
  _count: { select: { shipments: true } },
} satisfies Prisma.ImportOperationSelect;

export type ImportOperationSafeRow = Prisma.ImportOperationGetPayload<{
  select: typeof IMPORT_OPERATION_SAFE_SELECT;
}>;

export function toSafeImportOperation(
  row: ImportOperationSafeRow,
): SafeImportOperation {
  return {
    id: row.id,
    reference: row.reference,
    description: row.description,
    originCountry: row.originCountry,
    destinationCountry: row.destinationCountry,
    status: row.status,
    externalReference: row.externalReference,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    completedBy: row.completedBy,
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy,
    cancellationReason: row.cancellationReason,
    shipmentCount: row._count.shipments,
  };
}

import { Prisma } from '@prisma/client';
import {
  SafeImportOperation,
  SafeLinkedPurchaseInvoice,
} from '../types/safe-import-operation';

const ACTOR_SUMMARY_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

const LINKED_INVOICE_SELECT = {
  id: true,
  documentType: true,
  documentSeries: true,
  documentNumber: true,
  status: true,
  currencyCode: true,
  supplier: {
    select: {
      id: true,
      legalName: true,
      documentType: true,
      documentNumber: true,
      countryCode: true,
    },
  },
} satisfies Prisma.PurchaseInvoiceSelect;

export const IMPORT_OPERATION_SAFE_SELECT = {
  id: true,
  reference: true,
  description: true,
  originCountry: true,
  destinationCountry: true,
  status: true,
  externalReference: true,
  notes: true,
  purchaseInvoiceId: true,
  isLegacyUnlinked: true,
  purchaseInvoice: { select: LINKED_INVOICE_SELECT },
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

/** «F001-123» o «123» (sin serie). */
export function formatInvoiceDocumentLabel(
  series: string | null,
  number: string,
): string {
  return series !== null && series.trim().length > 0
    ? `${series}-${number}`
    : number;
}

function toLinkedInvoice(
  invoice: NonNullable<ImportOperationSafeRow['purchaseInvoice']>,
): SafeLinkedPurchaseInvoice {
  return {
    id: invoice.id,
    documentType: invoice.documentType,
    documentSeries: invoice.documentSeries,
    documentNumber: invoice.documentNumber,
    documentLabel: formatInvoiceDocumentLabel(
      invoice.documentSeries,
      invoice.documentNumber,
    ),
    status: invoice.status,
    currencyCode: invoice.currencyCode,
    canAssignLines: invoice.status === 'CONFIRMED',
    supplier: invoice.supplier,
  };
}

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
    purchaseInvoiceId: row.purchaseInvoiceId,
    isLegacyUnlinked: row.isLegacyUnlinked,
    purchaseInvoice:
      row.purchaseInvoice === null ? null : toLinkedInvoice(row.purchaseInvoice),
    // Solo el detalle (GET /import-operations/:id) carga las líneas de la compra.
    invoiceLines: null,
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

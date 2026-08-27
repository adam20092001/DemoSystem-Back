import { Prisma } from '@prisma/client';
import {
  ElectronicDocumentItemSnapshot,
  ElectronicDocumentSnapshot,
} from '../types/electronic-document-snapshot';

const ELECTRONIC_DOCUMENT_ITEM_SELECT = {
  id: true,
  lineNumber: true,
  productSku: true,
  description: true,
  unitCode: true,
  unitName: true,
  unitAbbreviation: true,
  quantity: true,
  unitPrice: true,
  lineTotal: true,
} satisfies Prisma.ElectronicDocumentItemSelect;

/**
 * Select explícito de un documento fiscal + sus líneas (Bloque 11C). Sin
 * DTO/Swagger todavía: este select alimenta ElectronicDocumentSnapshot,
 * consumido directamente por el servicio y sus pruebas.
 */
export const ELECTRONIC_DOCUMENT_SAFE_SELECT = {
  id: true,
  saleId: true,
  fiscalSeriesId: true,
  documentType: true,
  series: true,
  number: true,
  status: true,
  providerCode: true,
  currencyCode: true,
  issuerTaxId: true,
  issuerBusinessName: true,
  issuerAddress: true,
  customerDocumentType: true,
  customerDocumentNumber: true,
  customerName: true,
  customerAddress: true,
  subtotal: true,
  discountAmount: true,
  taxableBase: true,
  taxAmount: true,
  total: true,
  providerExternalId: true,
  providerStatus: true,
  providerMessage: true,
  submissionCount: true,
  issuedAt: true,
  lastSubmittedAt: true,
  acceptedAt: true,
  rejectedAt: true,
  createdAt: true,
  updatedAt: true,
  items: {
    select: ELECTRONIC_DOCUMENT_ITEM_SELECT,
    orderBy: { lineNumber: 'asc' },
  },
} satisfies Prisma.ElectronicDocumentSelect;

export type ElectronicDocumentSafeRow = Prisma.ElectronicDocumentGetPayload<{
  select: typeof ELECTRONIC_DOCUMENT_SAFE_SELECT;
}>;

function toItemSnapshot(
  row: ElectronicDocumentSafeRow['items'][number],
): ElectronicDocumentItemSnapshot {
  return {
    id: row.id,
    lineNumber: row.lineNumber,
    productSku: row.productSku,
    description: row.description,
    unitCode: row.unitCode,
    unitName: row.unitName,
    unitAbbreviation: row.unitAbbreviation,
    quantity: row.quantity.toFixed(3),
    unitPrice: row.unitPrice.toFixed(2),
    lineTotal: row.lineTotal.toFixed(2),
  };
}

/** Decimal siempre como string de 2 decimales fijos, nunca Prisma.Decimal ni number. */
export function toElectronicDocumentSnapshot(
  row: ElectronicDocumentSafeRow,
): ElectronicDocumentSnapshot {
  return {
    id: row.id,
    saleId: row.saleId,
    fiscalSeriesId: row.fiscalSeriesId,
    documentType: row.documentType,
    series: row.series,
    number: row.number,
    status: row.status,
    providerCode: row.providerCode,
    currencyCode: row.currencyCode,
    issuerTaxId: row.issuerTaxId,
    issuerBusinessName: row.issuerBusinessName,
    issuerAddress: row.issuerAddress,
    customerDocumentType: row.customerDocumentType,
    customerDocumentNumber: row.customerDocumentNumber,
    customerName: row.customerName,
    customerAddress: row.customerAddress,
    subtotal: row.subtotal.toFixed(2),
    discountAmount: row.discountAmount.toFixed(2),
    taxableBase: row.taxableBase.toFixed(2),
    taxAmount: row.taxAmount.toFixed(2),
    total: row.total.toFixed(2),
    providerExternalId: row.providerExternalId,
    providerStatus: row.providerStatus,
    providerMessage: row.providerMessage,
    submissionCount: row.submissionCount,
    issuedAt: row.issuedAt,
    lastSubmittedAt: row.lastSubmittedAt,
    acceptedAt: row.acceptedAt,
    rejectedAt: row.rejectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    items: row.items.map(toItemSnapshot),
  };
}

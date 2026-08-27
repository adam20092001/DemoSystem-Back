import { Prisma } from '@prisma/client';
import { FISCAL_NUMBER_PAD_LENGTH } from '../constants/electronic-invoicing.constants';
import {
  ElectronicDocumentItemSnapshot,
  ElectronicDocumentSnapshot,
} from '../types/electronic-document-snapshot';
import {
  SafeElectronicDocument,
  SafeElectronicDocumentItem,
  SafeElectronicDocumentListItem,
} from '../types/safe-electronic-document';

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

// ==========================================================================
// Bloque 11D — respuestas HTTP seguras (list/detail). Selects DISTINTOS del
// interno ELECTRONIC_DOCUMENT_SAFE_SELECT de arriba (motor de emisión, sin
// tocar en este bloque): estos incluyen sale.number (necesario para
// saleNumber en la respuesta) y NUNCA providerExternalId/fiscalSeriesId.
// ==========================================================================

/** "F001" + 1 -> "F001-00000001" (Bloque 11D §14). Nunca almacenado en BD. */
export function computeFullNumber(series: string, number: number): string {
  return `${series}-${String(number).padStart(FISCAL_NUMBER_PAD_LENGTH, '0')}`;
}

const SALE_NUMBER_SELECT = {
  select: { number: true },
} satisfies { select: Prisma.SaleSelect };

/** Select de listado (Bloque 11D §24): NUNCA ítems. */
export const ELECTRONIC_DOCUMENT_LIST_SELECT = {
  id: true,
  saleId: true,
  sale: SALE_NUMBER_SELECT,
  documentType: true,
  series: true,
  number: true,
  status: true,
  currencyCode: true,
  customerDocumentType: true,
  customerDocumentNumber: true,
  customerName: true,
  subtotal: true,
  discountAmount: true,
  taxableBase: true,
  taxAmount: true,
  total: true,
  providerCode: true,
  providerStatus: true,
  issuedAt: true,
  lastSubmittedAt: true,
  acceptedAt: true,
  rejectedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ElectronicDocumentSelect;

export type ElectronicDocumentListRow = Prisma.ElectronicDocumentGetPayload<{
  select: typeof ELECTRONIC_DOCUMENT_LIST_SELECT;
}>;

/** Select de detalle (Bloque 11D §24): un único nested select de ítems, sin N+1. */
export const ELECTRONIC_DOCUMENT_DETAIL_SELECT = {
  ...ELECTRONIC_DOCUMENT_LIST_SELECT,
  issuerTaxId: true,
  issuerBusinessName: true,
  issuerAddress: true,
  customerAddress: true,
  providerMessage: true,
  submissionCount: true,
  items: {
    select: ELECTRONIC_DOCUMENT_ITEM_SELECT,
    orderBy: { lineNumber: 'asc' },
  },
} satisfies Prisma.ElectronicDocumentSelect;

export type ElectronicDocumentDetailRow = Prisma.ElectronicDocumentGetPayload<{
  select: typeof ELECTRONIC_DOCUMENT_DETAIL_SELECT;
}>;

function toSafeItem(
  row: ElectronicDocumentDetailRow['items'][number],
): SafeElectronicDocumentItem {
  return {
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

/** Nunca providerExternalId (Bloque 11D §15, reservado para reconciliación interna futura). */
export function toSafeElectronicDocumentListItem(
  row: ElectronicDocumentListRow,
): SafeElectronicDocumentListItem {
  return {
    id: row.id,
    saleId: row.saleId,
    saleNumber: row.sale.number,
    documentType: row.documentType,
    series: row.series,
    number: row.number,
    fullNumber: computeFullNumber(row.series, row.number),
    status: row.status,
    currencyCode: row.currencyCode,
    customerDocumentType: row.customerDocumentType,
    customerDocumentNumber: row.customerDocumentNumber,
    customerName: row.customerName,
    subtotal: row.subtotal.toFixed(2),
    discountAmount: row.discountAmount.toFixed(2),
    taxableBase: row.taxableBase.toFixed(2),
    taxAmount: row.taxAmount.toFixed(2),
    total: row.total.toFixed(2),
    providerCode: row.providerCode,
    providerStatus: row.providerStatus,
    issuedAt: row.issuedAt,
    lastSubmittedAt: row.lastSubmittedAt,
    acceptedAt: row.acceptedAt,
    rejectedAt: row.rejectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSafeElectronicDocument(
  row: ElectronicDocumentDetailRow,
): SafeElectronicDocument {
  return {
    ...toSafeElectronicDocumentListItem(row),
    issuerTaxId: row.issuerTaxId,
    issuerBusinessName: row.issuerBusinessName,
    issuerAddress: row.issuerAddress,
    customerAddress: row.customerAddress,
    providerMessage: row.providerMessage,
    submissionCount: row.submissionCount,
    items: row.items.map(toSafeItem),
  };
}

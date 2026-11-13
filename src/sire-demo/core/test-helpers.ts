import { Prisma } from '@prisma/client';
import { RawRceDocument, RawRvieDocument } from './types';

/** Utilidades SOLO para pruebas (no se importan desde código de producción). */
export const dec = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

export function rvieRaw(
  overrides: Partial<RawRvieDocument> = {},
): RawRvieDocument {
  return {
    register: 'RVIE',
    refId: 'ref-1',
    documentType: 'FACTURA',
    series: 'F001',
    number: 1,
    status: 'ACCEPTED',
    providerCode: 'MOCK',
    issuedAt: new Date('2026-01-05T15:00:00.000Z'),
    currencyCode: 'PEN',
    customerDocumentType: 'RUC',
    customerDocumentNumber: '99999000001',
    customerName: 'DEMO CLIENTE 1 SAC',
    taxableBase: dec('847.46'),
    taxAmount: dec('152.54'),
    total: dec('1000.00'),
    ...overrides,
  };
}

export function rceRaw(
  overrides: Partial<RawRceDocument> = {},
): RawRceDocument {
  return {
    register: 'RCE',
    refId: 'ref-1',
    documentType: 'FACTURA',
    documentSeries: 'E001',
    documentNumber: '00000101',
    status: 'CONFIRMED',
    issueDate: new Date('2026-01-03T00:00:00.000Z'),
    accountingDate: new Date('2026-01-03T00:00:00.000Z'),
    currencyCode: 'PEN',
    supplierDocumentType: 'RUC',
    supplierDocumentNumber: '99999100001',
    supplierLegalName: 'DEMO PROVEEDOR 1 SAC',
    subtotal: dec('847.46'),
    taxAmount: dec('152.54'),
    totalAmount: dec('1000.00'),
    ...overrides,
  };
}

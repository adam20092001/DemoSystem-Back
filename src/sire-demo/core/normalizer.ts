import {
  CustomerDocumentType,
  FiscalDocumentType,
  Prisma,
  PurchaseInvoiceDocumentType,
  SupplierDocumentType,
} from '@prisma/client';
import { businessToday, fromPrismaDate } from '../../common/date/business-date';
import { BOLETA_GENERIC_CUSTOMER_MAX_TOTAL } from '../../electronic-invoicing/constants/electronic-invoicing.constants';
import { SIRE_DEMO_CURRENCY } from '../sire-demo.constants';
import {
  normalizeDocNumber,
  normalizeNumber,
  normalizeSeries,
} from './document-key';
import { rcePeriodOf, rviePeriodOf } from './period';
import {
  CounterpartyIdentity,
  DataQualityFlag,
  NormalizedTaxDocument,
  RawRceDocument,
  RawRvieDocument,
  RawTaxDocument,
} from './types';

/**
 * CÓDIGOS PROVISIONALES (solo modo DEMO). Ver Plan V2 §6:
 *  - Comprobantes: 03 (boleta), 07 y 08 aparecen en los anexos públicos; la
 *    fila de factura (01) está elidida en la copia pública del Anexo I.
 *  - Documentos de identidad: catálogo 06 verificado (0,1,4,6,7,...); se
 *    asume igual a la Tabla 1 del RVIE (elidida en la copia pública).
 * OTHER y FOREIGN_TAX_ID NO se mapean arbitrariamente.
 */
export const PROVISIONAL_RVIE_DOC_TYPE_CODES: Readonly<
  Record<FiscalDocumentType, string>
> = { FACTURA: '01', BOLETA: '03' };

export const PROVISIONAL_RCE_DOC_TYPE_CODES: Readonly<
  Partial<Record<PurchaseInvoiceDocumentType, string>>
> = { FACTURA: '01', BOLETA: '03' };

export const PROVISIONAL_CUSTOMER_DOC_CODES: Readonly<
  Partial<Record<CustomerDocumentType, string>>
> = { RUC: '6', DNI: '1', CE: '4', PASSPORT: '7' };

export const PROVISIONAL_SUPPLIER_DOC_CODES: Readonly<
  Partial<Record<SupplierDocumentType, string>>
> = { RUC: '6', DNI: '1' };

const ZERO = new Prisma.Decimal(0);

function addFlag(flags: DataQualityFlag[], flag: DataQualityFlag): void {
  if (!flags.includes(flag)) {
    flags.push(flag);
  }
}

function blankToNull(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeCounterparty(input: {
  docTypeCode: string | null;
  hasDeclaredType: boolean;
  docNumber: string | null;
  name: string | null;
  optional: boolean;
  flags: DataQualityFlag[];
}): CounterpartyIdentity {
  const { flags } = input;
  const docNumberRaw = blankToNull(input.docNumber);
  const docNumber =
    docNumberRaw === null ? null : normalizeDocNumber(docNumberRaw);
  const name = blankToNull(input.name);

  if (input.hasDeclaredType && input.docTypeCode === null) {
    addFlag(flags, 'COUNTERPARTY_DOC_TYPE_UNMAPPED');
  }
  if (!input.optional) {
    if (!input.hasDeclaredType || docNumber === null || name === null) {
      addFlag(flags, 'COUNTERPARTY_INCOMPLETE');
    }
  } else if (input.hasDeclaredType && docNumber === null) {
    addFlag(flags, 'COUNTERPARTY_INCOMPLETE');
  }
  if (docNumber !== null) {
    const invalidRuc = input.docTypeCode === '6' && !/^\d{11}$/.test(docNumber);
    const invalidDni = input.docTypeCode === '1' && !/^\d{8}$/.test(docNumber);
    if (invalidRuc || invalidDni) {
      addFlag(flags, 'COUNTERPARTY_DOC_FORMAT_INVALID');
    }
  }

  return { docTypeCode: input.docTypeCode, docNumber, name };
}

/**
 * Tratamiento de montos (provisional): solo base, IGV y total. Si no hay IGV
 * y el total es positivo no se puede distinguir exonerado/inafecto/gravado,
 * así que la base queda sin clasificar (null).
 */
function normalizeAmounts(
  base: Prisma.Decimal,
  tax: Prisma.Decimal,
  total: Prisma.Decimal,
  flags: DataQualityFlag[],
): { taxableBase: Prisma.Decimal | null; igv: Prisma.Decimal } {
  let taxableBase: Prisma.Decimal | null = base;
  if (tax.equals(ZERO) && total.greaterThan(ZERO)) {
    taxableBase = null;
    addFlag(flags, 'TAX_TREATMENT_UNCLASSIFIED');
  } else if (!base.plus(tax).equals(total)) {
    addFlag(flags, 'ARITHMETIC_INCONSISTENT');
  }
  return { taxableBase, igv: tax };
}

export function normalizeRvieDocument(
  raw: RawRvieDocument,
): NormalizedTaxDocument {
  const flags: DataQualityFlag[] = [];
  const docTypeCode = PROVISIONAL_RVIE_DOC_TYPE_CODES[raw.documentType] ?? null;
  if (docTypeCode === null) {
    addFlag(flags, 'DOC_TYPE_UNMAPPED');
  }
  const currencyCode = raw.currencyCode.trim().toUpperCase();
  if (currencyCode !== SIRE_DEMO_CURRENCY) {
    addFlag(flags, 'CURRENCY_UNSUPPORTED');
  }

  const optionalCounterparty =
    raw.documentType === 'BOLETA' &&
    raw.total.lessThan(BOLETA_GENERIC_CUSTOMER_MAX_TOTAL);
  const counterparty = normalizeCounterparty({
    docTypeCode:
      raw.customerDocumentType === null
        ? null
        : (PROVISIONAL_CUSTOMER_DOC_CODES[raw.customerDocumentType] ?? null),
    hasDeclaredType: raw.customerDocumentType !== null,
    docNumber: raw.customerDocumentNumber,
    name: raw.customerName,
    optional: optionalCounterparty,
    flags,
  });
  const { taxableBase, igv } = normalizeAmounts(
    raw.taxableBase,
    raw.taxAmount,
    raw.total,
    flags,
  );

  return {
    refId: raw.refId,
    register: 'RVIE',
    period: rviePeriodOf(raw.issuedAt),
    docTypeCode,
    series: normalizeSeries(raw.series),
    number: normalizeNumber(String(raw.number)),
    issueDate: businessToday(raw.issuedAt),
    accountingDate: null,
    counterparty,
    currencyCode,
    taxableBase,
    igv,
    total: raw.total,
    internalStatus: `${raw.status}_${raw.providerCode}`,
    flags,
  };
}

export function normalizeRceDocument(
  raw: RawRceDocument,
): NormalizedTaxDocument {
  const flags: DataQualityFlag[] = [];
  const docTypeCode = PROVISIONAL_RCE_DOC_TYPE_CODES[raw.documentType] ?? null;
  if (docTypeCode === null) {
    addFlag(flags, 'DOC_TYPE_UNMAPPED');
  }
  const currencyCode = raw.currencyCode.trim().toUpperCase();
  if (currencyCode !== SIRE_DEMO_CURRENCY) {
    addFlag(flags, 'CURRENCY_UNSUPPORTED');
  }

  const counterparty = normalizeCounterparty({
    docTypeCode:
      PROVISIONAL_SUPPLIER_DOC_CODES[raw.supplierDocumentType] ?? null,
    hasDeclaredType: true,
    docNumber: raw.supplierDocumentNumber,
    name: raw.supplierLegalName,
    optional: false,
    flags,
  });
  const { taxableBase, igv } = normalizeAmounts(
    raw.subtotal,
    raw.taxAmount,
    raw.totalAmount,
    flags,
  );

  return {
    refId: raw.refId,
    register: 'RCE',
    period: rcePeriodOf(raw.accountingDate),
    docTypeCode,
    series: normalizeSeries(raw.documentSeries ?? ''),
    number: normalizeNumber(raw.documentNumber),
    issueDate: fromPrismaDate(raw.issueDate),
    accountingDate: fromPrismaDate(raw.accountingDate),
    counterparty,
    currencyCode,
    taxableBase,
    igv,
    total: raw.totalAmount,
    internalStatus: raw.status,
    flags,
  };
}

export function normalizeRawDocument(
  raw: RawTaxDocument,
): NormalizedTaxDocument {
  return raw.register === 'RVIE'
    ? normalizeRvieDocument(raw)
    : normalizeRceDocument(raw);
}

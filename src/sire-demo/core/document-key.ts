import { DocumentKey, NormalizedTaxDocument, SireRegister } from './types';

export function normalizeSeries(value: string): string {
  return value.trim().toUpperCase();
}

/** Número sin ceros a la izquierda si es puramente numérico; si no, mayúsculas sin espacios. */
export function normalizeNumber(value: string): string {
  const cleaned = value.trim().toUpperCase();
  return /^\d+$/.test(cleaned) ? cleaned.replace(/^0+(?=\d)/, '') : cleaned;
}

export function normalizeDocNumber(value: string): string {
  return value.trim().toUpperCase();
}

/** Nombre comparable: mayúsculas, sin acentos y con espacios colapsados. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function keyToString(register: SireRegister, key: DocumentKey): string {
  const base = `${key.docTypeCode}|${key.series}|${key.number}`;
  return register === 'RCE' ? `${key.supplierDocNumber ?? ''}|${base}` : base;
}

function compareNumbers(a: string, b: string): number {
  const bothNumeric = /^\d+$/.test(a) && /^\d+$/.test(b);
  if (bothNumeric) {
    if (a.length !== b.length) {
      return a.length - b.length;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orden determinista de claves: proveedor (RCE), tipo, serie y número. */
export function compareKeys(a: DocumentKey, b: DocumentKey): number {
  return (
    compareStrings(a.supplierDocNumber ?? '', b.supplierDocNumber ?? '') ||
    compareStrings(a.docTypeCode, b.docTypeCode) ||
    compareStrings(a.series, b.series) ||
    compareNumbers(a.number, b.number)
  );
}

/** Clave de conciliación de un documento POS normalizado; null si no puede construirse. */
export function documentKeyOf(doc: NormalizedTaxDocument): DocumentKey | null {
  if (doc.docTypeCode === null) {
    return null;
  }
  if (doc.register === 'RCE') {
    if (doc.counterparty.docNumber === null) {
      return null;
    }
    return {
      docTypeCode: doc.docTypeCode,
      series: doc.series,
      number: doc.number,
      supplierDocNumber: doc.counterparty.docNumber,
    };
  }
  return {
    docTypeCode: doc.docTypeCode,
    series: doc.series,
    number: doc.number,
  };
}

/** Orden estable de documentos normalizados: con clave por clave; sin clave al final por fecha y referencia. */
export function compareNormalizedDocuments(
  a: NormalizedTaxDocument,
  b: NormalizedTaxDocument,
): number {
  const keyA = documentKeyOf(a);
  const keyB = documentKeyOf(b);
  if (keyA && keyB) {
    // Desempate total: dos documentos POS pueden compartir clave (DUPLICATE_POS_KEY).
    return (
      compareKeys(keyA, keyB) ||
      compareStrings(a.issueDate, b.issueDate) ||
      compareStrings(a.refId, b.refId)
    );
  }
  if (keyA) {
    return -1;
  }
  if (keyB) {
    return 1;
  }
  return (
    compareStrings(a.issueDate, b.issueDate) || compareStrings(a.refId, b.refId)
  );
}

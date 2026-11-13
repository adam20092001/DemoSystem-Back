import { Prisma } from '@prisma/client';
import { SIRE_DEMO_CURRENCY } from '../sire-demo.constants';
import { compareNormalizedDocuments, documentKeyOf } from './document-key';
import {
  DEMO_V1_COLUMNS_LINE,
  buildDemoHeaderLine,
} from './demo-proposal.parser';
import { periodBounds } from './period';
import {
  KEY_BLOCKING_FLAGS,
  NormalizedTaxDocument,
  SireRegister,
} from './types';

const ONE = new Prisma.Decimal('1.00');
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[|\u0000-\u001F\u007F]/g;

function dmy(isoDate: string): string {
  return `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`;
}

function cleanName(value: string | null): string {
  return (value ?? '')
    .replace(UNSAFE_TEXT, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}

function padNumber(value: string): string {
  return /^\d+$/.test(value) ? value.padStart(8, '0') : value;
}

/** Un documento POS solo puede escribirse en el archivo si el parser lo aceptaría. */
function isRepresentable(doc: NormalizedTaxDocument): boolean {
  if (documentKeyOf(doc) === null) return false;
  if (doc.currencyCode !== SIRE_DEMO_CURRENCY) return false;
  if (doc.flags.some((flag) => KEY_BLOCKING_FLAGS.includes(flag))) return false;
  if (doc.series === '' || !/^[A-Z0-9]{1,20}$/.test(doc.series)) return false;
  if (!/^\d{1,20}$/.test(doc.number)) return false;
  const { docTypeCode, docNumber } = doc.counterparty;
  if ((docTypeCode === null) !== (docNumber === null)) return false;
  if (doc.register === 'RCE' && docNumber === null) return false;
  if (docNumber !== null && !/^[A-Z0-9-]{1,20}$/.test(docNumber)) return false;
  return true;
}

function row(fields: readonly string[]): string {
  return fields.join('|');
}

/**
 * Archivo DEMO_V1 derivado de los documentos POS REALES de un periodo, con
 * mutaciones DETERMINISTAS para que la conciliación tenga qué mostrar:
 *  - cada 7.º documento (por clave ordenada, desde el 3.º) cambia su total en +1.00;
 *  - cada 7.º (desde el 5.º) cambia el nombre de la contraparte;
 *  - se omite el último documento (si hay 2 o más);
 *  - se agrega una fila con serie ZZ99 inexistente en el POS;
 *  - se repite la primera fila.
 * Con pocos documentos solo aparecen algunos escenarios. Devuelve null si
 * ningún documento del periodo puede representarse.
 */
export function buildPosDerivedSampleFile(input: {
  register: SireRegister;
  period: string;
  documents: readonly NormalizedTaxDocument[];
}): string | null {
  const docs = input.documents
    .filter(isRepresentable)
    .sort(compareNormalizedDocuments);
  if (docs.length === 0) {
    return null;
  }

  const lines: string[] = [
    buildDemoHeaderLine({
      source: 'POS',
      register: input.register,
      period: input.period,
      fixtureSetVersion: null,
    }),
    DEMO_V1_COLUMNS_LINE,
  ];

  const dataRows: string[] = [];
  docs.forEach((doc, index) => {
    if (docs.length >= 2 && index === docs.length - 1) {
      return;
    }
    const total = index % 7 === 2 ? doc.total.plus(ONE) : doc.total;
    const name =
      index % 7 === 4
        ? `${cleanName(doc.counterparty.name)} (DEMO)`
        : cleanName(doc.counterparty.name);
    dataRows.push(
      row([
        doc.docTypeCode as string,
        doc.series,
        padNumber(doc.number),
        dmy(doc.issueDate),
        doc.counterparty.docTypeCode ?? '',
        doc.counterparty.docNumber ?? '',
        name,
        SIRE_DEMO_CURRENCY,
        (doc.taxableBase ?? new Prisma.Decimal(0)).toFixed(2),
        doc.igv.toFixed(2),
        total.toFixed(2),
      ]),
    );
  });

  const synthetic = row([
    '01',
    'ZZ99',
    '00000001',
    dmy(periodBounds(input.period).first),
    '6',
    '99999000099',
    input.register === 'RVIE'
      ? 'DEMO - CONTRAPARTE SINTETICA'
      : 'DEMO - PROVEEDOR SINTETICO',
    SIRE_DEMO_CURRENCY,
    '423.73',
    '76.27',
    '500.00',
  ]);

  lines.push(...dataRows, dataRows[0], synthetic);
  return `${lines.join('\n')}\n`;
}

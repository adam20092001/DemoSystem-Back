import { Prisma } from '@prisma/client';
import {
  buildDemoHeaderLine,
  DEMO_V1_COLUMNS_LINE,
} from '../core/demo-proposal.parser';
import { RawRceDocument, RawRvieDocument } from '../core/types';
import { FixtureSet } from './fixture-set';

/**
 * Conjunto de fixtures `demo-fixtures-v1`. INMUTABLE: cualquier cambio de
 * contenido exige una versión nueva (demo-fixtures-v2) y actualizar el
 * digest; la prueba de versionado falla si se edita sin cambiar la versión.
 *
 * Todos los datos son ficticios y claramente identificables: emisor y
 * contrapartes con prefijo 99999..., nombres que inician con "DEMO". Nunca se
 * insertan en ninguna tabla comercial: viven solo en memoria.
 *
 * El lado "POS" (documentos) y la propuesta (archivo DEMO_V1) son datos
 * INDEPENDIENTES; las diferencias entre ambos las calcula el motor real.
 *
 * Escenarios por registro (periodo 202601):
 *   8 coincidentes · 1 monto distinto · 1 contraparte distinta · 1 fecha
 *   distinta · 1 faltante en la propuesta · 1 duplicado en la propuesta ·
 *   1 faltante en el POS · 1 con datos insuficientes · 2 excluidos por estado.
 */

export const DEMO_FIXTURES_V1_VERSION = 'demo-fixtures-v1';
export const DEMO_FIXTURES_V1_PERIOD = '202601';
/** SHA-256 del contenido canónico del conjunto (ver computeFixtureSetDigest). */
export const DEMO_FIXTURES_V1_DIGEST =
  '78e83f0251d5fd923424214b86fd7c23e29dfd4872d4e895ea5f9ff45a1c541e';

const D = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

// --- RVIE: lado POS ---------------------------------------------------------

function rvie(input: {
  id: string;
  type: 'FACTURA' | 'BOLETA';
  series: string;
  number: number;
  day: number;
  status?: RawRvieDocument['status'];
  customer: { type: 'RUC' | 'DNI'; number: string; name: string };
  base: string;
  tax: string;
  total: string;
}): RawRvieDocument {
  return {
    register: 'RVIE',
    refId: `fixture-rvie-${input.id}`,
    documentType: input.type,
    series: input.series,
    number: input.number,
    status: input.status ?? 'ACCEPTED',
    providerCode: 'MOCK',
    // 15:00 UTC = 10:00 en America/Lima: mismo día calendario en ambos husos.
    issuedAt: new Date(Date.UTC(2026, 0, input.day, 15, 0, 0)),
    currencyCode: 'PEN',
    customerDocumentType: input.customer.type,
    customerDocumentNumber: input.customer.number,
    customerName: input.customer.name,
    taxableBase: D(input.base),
    taxAmount: D(input.tax),
    total: D(input.total),
  };
}

const cliente = (n: number): { type: 'RUC'; number: string; name: string } => ({
  type: 'RUC',
  number: `999990000${String(n).padStart(2, '0')}`,
  name: `DEMO CLIENTE ${n} SAC`,
});

const RVIE_DOCUMENTS: RawRvieDocument[] = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    rvie({
      id: `F001-${n}`,
      type: 'FACTURA',
      series: 'F001',
      number: n,
      day: n + 4,
      customer: cliente(n),
      base: '847.46',
      tax: '152.54',
      total: '1000.00',
    }),
  ),
  rvie({
    id: 'F001-9',
    type: 'FACTURA',
    series: 'F001',
    number: 9,
    day: 13,
    customer: cliente(9),
    base: '847.46',
    tax: '152.54',
    total: '1000.00',
  }),
  rvie({
    id: 'F001-10',
    type: 'FACTURA',
    series: 'F001',
    number: 10,
    day: 14,
    customer: cliente(10),
    base: '847.46',
    tax: '152.54',
    total: '1000.00',
  }),
  rvie({
    id: 'F001-11',
    type: 'FACTURA',
    series: 'F001',
    number: 11,
    day: 15,
    customer: cliente(11),
    base: '847.46',
    tax: '152.54',
    total: '1000.00',
  }),
  rvie({
    id: 'F001-12',
    type: 'FACTURA',
    series: 'F001',
    number: 12,
    day: 16,
    customer: cliente(12),
    base: '847.46',
    tax: '152.54',
    total: '1000.00',
  }),
  rvie({
    id: 'F001-13',
    type: 'FACTURA',
    series: 'F001',
    number: 13,
    day: 17,
    customer: cliente(13),
    base: '847.46',
    tax: '152.54',
    total: '1000.00',
  }),
  // Sin IGV con total positivo: el tratamiento tributario no puede clasificarse.
  rvie({
    id: 'B001-1',
    type: 'BOLETA',
    series: 'B001',
    number: 1,
    day: 18,
    customer: { type: 'DNI', number: '99999999', name: 'DEMO CLIENTE BOLETA' },
    base: '1000.00',
    tax: '0.00',
    total: '1000.00',
  }),
  // Excluidos por estado (no ACCEPTED).
  rvie({
    id: 'F001-90',
    type: 'FACTURA',
    series: 'F001',
    number: 90,
    day: 19,
    status: 'CREATED',
    customer: cliente(90),
    base: '847.46',
    tax: '152.54',
    total: '1000.00',
  }),
  rvie({
    id: 'F001-91',
    type: 'FACTURA',
    series: 'F001',
    number: 91,
    day: 20,
    status: 'REJECTED',
    customer: cliente(91),
    base: '847.46',
    tax: '152.54',
    total: '1000.00',
  }),
];

// --- RCE: lado POS ----------------------------------------------------------

function rce(input: {
  id: string;
  type?: RawRceDocument['documentType'];
  number: string;
  accountingDay: number;
  issueDate?: Date;
  status?: RawRceDocument['status'];
  supplier: { type: 'RUC' | 'DNI'; number: string; name: string };
  base: string;
  tax: string;
  total: string;
}): RawRceDocument {
  const accounting = new Date(Date.UTC(2026, 0, input.accountingDay));
  return {
    register: 'RCE',
    refId: `fixture-rce-${input.id}`,
    documentType: input.type ?? 'FACTURA',
    documentSeries: 'E001',
    documentNumber: input.number,
    status: input.status ?? 'CONFIRMED',
    issueDate: input.issueDate ?? accounting,
    accountingDate: accounting,
    currencyCode: 'PEN',
    supplierDocumentType: input.supplier.type,
    supplierDocumentNumber: input.supplier.number,
    supplierLegalName: input.supplier.name,
    subtotal: D(input.base),
    taxAmount: D(input.tax),
    totalAmount: D(input.total),
  };
}

const proveedor = (
  n: number,
): { type: 'RUC'; number: string; name: string } => ({
  type: 'RUC',
  number: `999991000${String(n).padStart(2, '0')}`,
  name: `DEMO PROVEEDOR ${n} SAC`,
});

const RCE_DOCUMENTS: RawRceDocument[] = [
  ...[1, 2, 3, 4, 5, 6, 7].map((n) =>
    rce({
      id: `E001-${100 + n}`,
      number: `00000${100 + n}`,
      accountingDay: n + 2,
      supplier: proveedor(n),
      base: '847.46',
      tax: '152.54',
      total: '1000.00',
    }),
  ),
  // Emitida en diciembre y contabilizada en enero: demuestra la regla DEMO del periodo (accountingDate).
  rce({
    id: 'E001-108',
    number: '00000108',
    accountingDay: 12,
    issueDate: new Date(Date.UTC(2025, 11, 28)),
    supplier: proveedor(8),
    base: '847.46',
    tax: '152.54',
    total: '1000.00',
  }),
  rce({
    id: 'E001-109',
    number: '00000109',
    accountingDay: 13,
    supplier: proveedor(9),
    base: '847.46',
    tax: '152.54',
    total: '1000.00',
  }),
  rce({
    id: 'E001-110',
    number: '00000110',
    accountingDay: 14,
    supplier: proveedor(10),
    base: '847.46',
    tax: '152.54',
    total: '1000.00',
  }),
  rce({
    id: 'E001-111',
    number: '00000111',
    accountingDay: 15,
    supplier: proveedor(11),
    base: '847.46',
    tax: '152.54',
    total: '1000.00',
  }),
  rce({
    id: 'E001-112',
    number: '00000112',
    accountingDay: 16,
    supplier: proveedor(12),
    base: '847.46',
    tax: '152.54',
    total: '1000.00',
  }),
  rce({
    id: 'E001-113',
    number: '00000113',
    accountingDay: 17,
    supplier: proveedor(13),
    base: '847.46',
    tax: '152.54',
    total: '1000.00',
  }),
  // RECIBO: tipo de comprobante sin código mapeado -> datos insuficientes.
  rce({
    id: 'R001-114',
    type: 'RECIBO',
    number: '00000114',
    accountingDay: 18,
    supplier: {
      type: 'DNI',
      number: '99999998',
      name: 'DEMO PROVEEDOR PERSONA',
    },
    base: '1000.00',
    tax: '0.00',
    total: '1000.00',
  }),
  // Excluidos por estado (no CONFIRMED).
  rce({
    id: 'E001-190',
    number: '00000190',
    accountingDay: 19,
    status: 'DRAFT',
    supplier: proveedor(90),
    base: '847.46',
    tax: '152.54',
    total: '1000.00',
  }),
  rce({
    id: 'E001-191',
    number: '00000191',
    accountingDay: 20,
    status: 'CANCELLED',
    supplier: proveedor(91),
    base: '847.46',
    tax: '152.54',
    total: '1000.00',
  }),
];

// --- Propuestas DEMO_V1 (archivos independientes del lado POS) ---------------

function proposalFile(register: 'RVIE' | 'RCE', rows: string[]): string {
  const header = buildDemoHeaderLine({
    source: 'DEMO_FIXTURES',
    register,
    period: DEMO_FIXTURES_V1_PERIOD,
    fixtureSetVersion: DEMO_FIXTURES_V1_VERSION,
  });
  return `${[header, DEMO_V1_COLUMNS_LINE, ...rows].join('\n')}\n`;
}

const RVIE_PROPOSAL_ROWS: string[] = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(
    (n) =>
      `01|F001|${String(n).padStart(8, '0')}|${String(n + 4).padStart(2, '0')}/01/2026|6|999990000${String(n).padStart(2, '0')}|DEMO CLIENTE ${n} SAC|PEN|847.46|152.54|1000.00`,
  ),
  // Monto distinto.
  '01|F001|00000009|13/01/2026|6|99999000009|DEMO CLIENTE 9 SAC|PEN|932.20|167.80|1100.00',
  // Contraparte distinta (documento y nombre).
  '01|F001|00000010|14/01/2026|6|99999000099|DEMO OTRO CLIENTE SAC|PEN|847.46|152.54|1000.00',
  // Fecha distinta (POS: 15/01).
  '01|F001|00000011|16/01/2026|6|99999000011|DEMO CLIENTE 11 SAC|PEN|847.46|152.54|1000.00',
  // Duplicado en la propuesta.
  '01|F001|00000013|17/01/2026|6|99999000013|DEMO CLIENTE 13 SAC|PEN|847.46|152.54|1000.00',
  '01|F001|00000013|17/01/2026|6|99999000013|DEMO CLIENTE 13 SAC|PEN|847.46|152.54|1000.00',
  // Datos insuficientes en el POS (IGV sin clasificar): el total coincide.
  '03|B001|00000001|18/01/2026|1|99999999|DEMO CLIENTE BOLETA|PEN|1000.00|0.00|1000.00',
  // Faltante en el POS.
  '01|ZZ99|00000001|20/01/2026|6|99999000099|DEMO - CONTRAPARTE SINTETICA|PEN|423.73|76.27|500.00',
];

const RCE_PROPOSAL_ROWS: string[] = [
  ...[1, 2, 3, 4, 5, 6, 7].map(
    (n) =>
      `01|E001|00000${100 + n}|${String(n + 2).padStart(2, '0')}/01/2026|6|999991000${String(n).padStart(2, '0')}|DEMO PROVEEDOR ${n} SAC|PEN|847.46|152.54|1000.00`,
  ),
  // Emisión en diciembre (fuera del mes del periodo): la fecha de emisión no define el periodo.
  '01|E001|00000108|28/12/2025|6|99999100008|DEMO PROVEEDOR 8 SAC|PEN|847.46|152.54|1000.00',
  // Monto distinto.
  '01|E001|00000109|13/01/2026|6|99999100009|DEMO PROVEEDOR 9 SAC|PEN|932.20|167.80|1100.00',
  // Contraparte distinta (nombre).
  '01|E001|00000110|14/01/2026|6|99999100010|DEMO PROVEEDOR DIEZ SAC|PEN|847.46|152.54|1000.00',
  // Fecha distinta (POS: 15/01).
  '01|E001|00000111|16/01/2026|6|99999100011|DEMO PROVEEDOR 11 SAC|PEN|847.46|152.54|1000.00',
  // Duplicado en la propuesta.
  '01|E001|00000113|17/01/2026|6|99999100013|DEMO PROVEEDOR 13 SAC|PEN|847.46|152.54|1000.00',
  '01|E001|00000113|17/01/2026|6|99999100013|DEMO PROVEEDOR 13 SAC|PEN|847.46|152.54|1000.00',
  // Faltante en el POS.
  '01|E001|00000199|20/01/2026|6|99999100099|DEMO - PROVEEDOR SINTETICO|PEN|423.73|76.27|500.00',
];

export const DEMO_FIXTURES_V1: FixtureSet = {
  version: DEMO_FIXTURES_V1_VERSION,
  digest: DEMO_FIXTURES_V1_DIGEST,
  periods: { RVIE: [DEMO_FIXTURES_V1_PERIOD], RCE: [DEMO_FIXTURES_V1_PERIOD] },
  documents: { RVIE: RVIE_DOCUMENTS, RCE: RCE_DOCUMENTS },
  sampleFiles: {
    RVIE: {
      period: DEMO_FIXTURES_V1_PERIOD,
      content: proposalFile('RVIE', RVIE_PROPOSAL_ROWS),
    },
    RCE: {
      period: DEMO_FIXTURES_V1_PERIOD,
      content: proposalFile('RCE', RCE_PROPOSAL_ROWS),
    },
  },
};

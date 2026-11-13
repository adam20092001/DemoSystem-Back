import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { SIRE_DEMO_CURRENCY } from '../sire-demo.constants';
import {
  compareKeys,
  compareNormalizedDocuments,
  documentKeyOf,
  keyToString,
  normalizeName,
} from './document-key';
import {
  CounterpartyIdentity,
  DataQualityFlag,
  DocumentKey,
  KEY_BLOCKING_FLAGS,
  NormalizedTaxDocument,
  ProposalRow,
  RECONCILIATION_CLASSIFICATIONS,
  ReconciliationClassification,
  SireRegister,
} from './types';

/**
 * Motor ÚNICO y puro de conciliación (Plan V2 + Addendum §2). Compara los
 * documentos POS normalizados contra las filas de una propuesta DEMO_V1.
 * Sin Prisma, sin I/O, sin hardcodeo: todo resultado se calcula.
 *
 * INVARIANTES (verificados por pruebas de propiedad):
 *  I1  Cada documento POS aparece en exactamente UN ítem.
 *  I2  Cada fila de la propuesta aparece en exactamente UN ítem
 *      (suma de `occurrences` = número de filas).
 *  I3  summary.total = ítems = suma de los conteos por clase.
 *  I4  Las clases son excluyentes (precedencia fija).
 *  I5  occurrences >= 2 si y solo si la clase es DUPLICATE_IN_PROPOSAL.
 *  I6  MISSING_IN_POS = clave sin documento POS; MISSING_IN_PROPOSAL = clave
 *      POS sin filas.
 *  I7  MATCHED exige cero diferencias y ninguna alerta bloqueante.
 *  I8  Cada documento POS suma una vez; cada clave de la propuesta suma UNA
 *      vez (primera aparición); el excedente de duplicados va aparte.
 *  I9  proposalRaw = proposalDistinct + duplicateSurplus.
 *  I10 La suma de totales por clase = total general; delta =
 *      proposalDistinct - pos.
 *  I11 Solo se suman montos PEN; otras monedas no se suman ni convierten.
 *  I12 Prisma.Decimal exacto; nunca number.
 *  I13 Resumen y totales cubren el conjunto completo.
 */

export interface ReconciliationDifference {
  field: string;
  pos: string | null;
  proposal: string | null;
  /** proposal - pos, solo para campos monetarios. */
  delta: string | null;
}

export interface ReconciliationPosSide {
  refId: string;
  issueDate: string;
  currencyCode: string;
  counterparty: CounterpartyIdentity;
  taxableBase: Prisma.Decimal | null;
  igv: Prisma.Decimal;
  total: Prisma.Decimal;
  flags: DataQualityFlag[];
  internalStatus: string;
}

export interface ReconciliationProposalSide {
  lineNumbers: number[];
  occurrences: number;
  issueDate: string;
  counterparty: CounterpartyIdentity;
  /** Valores de la PRIMERA aparición de la clave. */
  taxableBase: Prisma.Decimal;
  igv: Prisma.Decimal;
  total: Prisma.Decimal;
  /** Suma de las apariciones adicionales (0.00 si no hay duplicado). */
  duplicateSurplusTotal: Prisma.Decimal;
}

export interface ReconciliationItem {
  classification: ReconciliationClassification;
  key: DocumentKey | null;
  differences: ReconciliationDifference[];
  pos: ReconciliationPosSide | null;
  proposal: ReconciliationProposalSide | null;
}

export interface ClassificationTotals {
  count: number;
  posTotal: Prisma.Decimal;
  proposalTotal: Prisma.Decimal;
}

export interface ReconciliationSummary {
  currencyCode: typeof SIRE_DEMO_CURRENCY;
  foreignCurrencyDocuments: { currencyCode: string; documents: number }[];
  total: number;
  byClassification: Record<ReconciliationClassification, ClassificationTotals>;
  totals: {
    pos: Prisma.Decimal;
    proposalDistinct: Prisma.Decimal;
    duplicateSurplus: Prisma.Decimal;
    proposalRaw: Prisma.Decimal;
    delta: Prisma.Decimal;
  };
}

export interface ReconciliationResult {
  counts: { posDocuments: number; proposalRows: number; items: number };
  summary: ReconciliationSummary;
  items: ReconciliationItem[];
  /** SHA-256 del listado canónico: permite verificar que API y Excel hablan de lo mismo. */
  resultDigest: string;
}

const ZERO = new Prisma.Decimal(0);

function money(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

function proposalKey(register: SireRegister, row: ProposalRow): DocumentKey {
  const key: DocumentKey = {
    docTypeCode: row.docTypeCode,
    series: row.series,
    number: row.number,
  };
  if (register === 'RCE') {
    key.supplierDocNumber = row.cpDocNumber ?? '';
  }
  return key;
}

function posSideOf(
  doc: NormalizedTaxDocument,
  extraFlag?: DataQualityFlag,
): ReconciliationPosSide {
  const flags =
    extraFlag && !doc.flags.includes(extraFlag)
      ? [...doc.flags, extraFlag]
      : [...doc.flags];
  return {
    refId: doc.refId,
    issueDate: doc.issueDate,
    currencyCode: doc.currencyCode,
    counterparty: doc.counterparty,
    taxableBase: doc.taxableBase,
    igv: doc.igv,
    total: doc.total,
    flags,
    internalStatus: doc.internalStatus,
  };
}

function proposalSideOf(rows: ProposalRow[]): ReconciliationProposalSide {
  const sorted = [...rows].sort((a, b) => a.lineNumber - b.lineNumber);
  const first = sorted[0];
  const surplus = sorted
    .slice(1)
    .reduce((acc, row) => acc.plus(row.total), ZERO);
  return {
    lineNumbers: sorted.map((row) => row.lineNumber),
    occurrences: sorted.length,
    issueDate: first.issueDate,
    counterparty: {
      docTypeCode: first.cpDocTypeCode,
      docNumber: first.cpDocNumber,
      name: first.cpName,
    },
    taxableBase: first.taxableBase,
    igv: first.igv,
    total: first.total,
    duplicateSurplusTotal: surplus,
  };
}

function compareAmount(
  field: string,
  pos: Prisma.Decimal,
  proposal: Prisma.Decimal,
  out: ReconciliationDifference[],
): void {
  if (!pos.equals(proposal)) {
    out.push({
      field,
      pos: money(pos),
      proposal: money(proposal),
      delta: money(proposal.minus(pos)),
    });
  }
}

function compareText(
  field: string,
  pos: string,
  proposal: string,
  out: ReconciliationDifference[],
): void {
  if (pos !== proposal) {
    out.push({
      field,
      pos: pos === '' ? null : pos,
      proposal: proposal === '' ? null : proposal,
      delta: null,
    });
  }
}

const AMOUNT_FIELDS = ['taxableBase', 'igv', 'total'];
const PARTY_FIELDS = [
  'counterpartyDocType',
  'counterpartyDocNumber',
  'counterpartyName',
];

function comparePair(
  pos: ReconciliationPosSide,
  proposal: ReconciliationProposalSide,
): ReconciliationDifference[] {
  const diffs: ReconciliationDifference[] = [];
  // Si el POS no pudo clasificar la base, solo el total es comparable.
  if (pos.taxableBase !== null) {
    compareAmount('taxableBase', pos.taxableBase, proposal.taxableBase, diffs);
    compareAmount('igv', pos.igv, proposal.igv, diffs);
  }
  compareAmount('total', pos.total, proposal.total, diffs);
  compareText(
    'counterpartyDocType',
    pos.counterparty.docTypeCode ?? '',
    proposal.counterparty.docTypeCode ?? '',
    diffs,
  );
  compareText(
    'counterpartyDocNumber',
    pos.counterparty.docNumber ?? '',
    proposal.counterparty.docNumber ?? '',
    diffs,
  );
  compareText(
    'counterpartyName',
    normalizeName(pos.counterparty.name ?? ''),
    normalizeName(proposal.counterparty.name ?? ''),
    diffs,
  );
  compareText('issueDate', pos.issueDate, proposal.issueDate, diffs);
  return diffs;
}

function classifyPair(
  diffs: ReconciliationDifference[],
  pos: ReconciliationPosSide,
): ReconciliationClassification {
  if (diffs.some((d) => AMOUNT_FIELDS.includes(d.field))) {
    return 'AMOUNT_MISMATCH';
  }
  if (diffs.some((d) => PARTY_FIELDS.includes(d.field))) {
    return 'PARTY_MISMATCH';
  }
  if (diffs.some((d) => d.field === 'issueDate')) {
    return 'DATE_MISMATCH';
  }
  if (pos.flags.includes('TAX_TREATMENT_UNCLASSIFIED')) {
    return 'INSUFFICIENT_DATA';
  }
  return 'MATCHED';
}

function emptyByClassification(): Record<
  ReconciliationClassification,
  ClassificationTotals
> {
  const out = {} as Record<ReconciliationClassification, ClassificationTotals>;
  for (const classification of RECONCILIATION_CLASSIFICATIONS) {
    out[classification] = { count: 0, posTotal: ZERO, proposalTotal: ZERO };
  }
  return out;
}

function digestOf(items: ReconciliationItem[], register: SireRegister): string {
  const hash = createHash('sha256');
  for (const item of items) {
    hash.update(
      [
        item.classification,
        item.key ? keyToString(register, item.key) : '-',
        item.pos ? `${item.pos.refId}:${money(item.pos.total)}` : '-',
        item.proposal
          ? `${item.proposal.lineNumbers.join(',')}:${money(item.proposal.total)}:${money(item.proposal.duplicateSurplusTotal)}`
          : '-',
      ].join('|') + '\n',
    );
  }
  return hash.digest('hex');
}

export function computeReconciliation(
  register: SireRegister,
  posDocuments: readonly NormalizedTaxDocument[],
  proposalRows: readonly ProposalRow[],
): ReconciliationResult {
  // 1. Documentos POS: con clave (única) o sin clave.
  const keyedCandidates = new Map<string, NormalizedTaxDocument[]>();
  const unkeyed: { doc: NormalizedTaxDocument; extraFlag?: DataQualityFlag }[] =
    [];

  for (const doc of posDocuments) {
    const key = documentKeyOf(doc);
    const blocked = doc.flags.some((flag) => KEY_BLOCKING_FLAGS.includes(flag));
    if (key === null || blocked) {
      unkeyed.push({ doc });
      continue;
    }
    const k = keyToString(register, key);
    const bucket = keyedCandidates.get(k);
    if (bucket) {
      bucket.push(doc);
    } else {
      keyedCandidates.set(k, [doc]);
    }
  }

  const posByKey = new Map<
    string,
    { doc: NormalizedTaxDocument; key: DocumentKey }
  >();
  for (const [k, docs] of keyedCandidates) {
    if (docs.length > 1) {
      // Defensa: una clave POS repetida nunca se concilia; cada documento queda sin clave.
      for (const doc of docs) {
        unkeyed.push({ doc, extraFlag: 'DUPLICATE_POS_KEY' });
      }
      continue;
    }
    const doc = docs[0];
    const key = documentKeyOf(doc);
    if (key !== null) {
      posByKey.set(k, { doc, key });
    }
  }

  // 2. Filas de la propuesta agrupadas por clave.
  const proposalByKey = new Map<
    string,
    { key: DocumentKey; rows: ProposalRow[] }
  >();
  for (const row of proposalRows) {
    const key = proposalKey(register, row);
    const k = keyToString(register, key);
    const group = proposalByKey.get(k);
    if (group) {
      group.rows.push(row);
    } else {
      proposalByKey.set(k, { key, rows: [row] });
    }
  }

  // 3. Ítems por clave (unión de ambos lados).
  const keyed: { sortKey: DocumentKey; item: ReconciliationItem }[] = [];
  const allKeys = new Set<string>([
    ...posByKey.keys(),
    ...proposalByKey.keys(),
  ]);

  for (const k of allKeys) {
    const posEntry = posByKey.get(k);
    const group = proposalByKey.get(k);
    const key = (posEntry?.key ?? group?.key) as DocumentKey;
    const pos = posEntry ? posSideOf(posEntry.doc) : null;
    const proposal = group ? proposalSideOf(group.rows) : null;

    let classification: ReconciliationClassification;
    let differences: ReconciliationDifference[] = [];

    if (proposal && proposal.occurrences >= 2) {
      classification = 'DUPLICATE_IN_PROPOSAL';
    } else if (pos && !proposal) {
      classification = 'MISSING_IN_PROPOSAL';
    } else if (!pos && proposal) {
      classification = 'MISSING_IN_POS';
    } else if (pos && proposal) {
      differences = comparePair(pos, proposal);
      classification = classifyPair(differences, pos);
    } else {
      continue;
    }
    keyed.push({
      sortKey: key,
      item: { classification, key, differences, pos, proposal },
    });
  }
  keyed.sort((a, b) => compareKeys(a.sortKey, b.sortKey));

  // 4. Ítems sin clave (INSUFFICIENT_DATA), orden estable.
  unkeyed.sort((a, b) => compareNormalizedDocuments(a.doc, b.doc));
  const unkeyedItems: ReconciliationItem[] = unkeyed.map(
    ({ doc, extraFlag }) => ({
      classification: 'INSUFFICIENT_DATA',
      key: null,
      differences: [],
      pos: posSideOf(doc, extraFlag),
      proposal: null,
    }),
  );

  const items = [...keyed.map((entry) => entry.item), ...unkeyedItems];

  // 5. Resumen y totales (solo PEN; nunca conversión).
  const byClassification = emptyByClassification();
  let posTotal = ZERO;
  let proposalDistinct = ZERO;
  let surplus = ZERO;
  const foreign = new Map<string, number>();

  for (const item of items) {
    const bucket = byClassification[item.classification];
    bucket.count += 1;
    if (item.pos) {
      if (item.pos.currencyCode === SIRE_DEMO_CURRENCY) {
        bucket.posTotal = bucket.posTotal.plus(item.pos.total);
        posTotal = posTotal.plus(item.pos.total);
      } else {
        foreign.set(
          item.pos.currencyCode,
          (foreign.get(item.pos.currencyCode) ?? 0) + 1,
        );
      }
    }
    if (item.proposal) {
      bucket.proposalTotal = bucket.proposalTotal.plus(item.proposal.total);
      proposalDistinct = proposalDistinct.plus(item.proposal.total);
      surplus = surplus.plus(item.proposal.duplicateSurplusTotal);
    }
  }

  return {
    counts: {
      posDocuments: posDocuments.length,
      proposalRows: proposalRows.length,
      items: items.length,
    },
    summary: {
      currencyCode: SIRE_DEMO_CURRENCY,
      foreignCurrencyDocuments: [...foreign.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([currencyCode, documents]) => ({ currencyCode, documents })),
      total: items.length,
      byClassification,
      totals: {
        pos: posTotal,
        proposalDistinct,
        duplicateSurplus: surplus,
        proposalRaw: proposalDistinct.plus(surplus),
        delta: proposalDistinct.minus(posTotal),
      },
    },
    items,
    resultDigest: digestOf(items, register),
  };
}

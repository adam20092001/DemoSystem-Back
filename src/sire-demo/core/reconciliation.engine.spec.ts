import { Prisma } from '@prisma/client';
import { normalizeRceDocument, normalizeRvieDocument } from './normalizer';
import {
  ProposalRow,
  RECONCILIATION_CLASSIFICATIONS,
  ReconciliationClassification,
} from './types';
import {
  ReconciliationResult,
  computeReconciliation,
} from './reconciliation.engine';
import { dec, rceRaw, rvieRaw } from './test-helpers';

function row(overrides: Partial<ProposalRow> = {}): ProposalRow {
  return {
    lineNumber: 1,
    docTypeCode: '01',
    series: 'F001',
    number: '1',
    issueDate: '2026-01-05',
    cpDocTypeCode: '6',
    cpDocNumber: '99999000001',
    cpName: 'DEMO CLIENTE 1 SAC',
    currencyCode: 'PEN',
    taxableBase: dec('847.46'),
    igv: dec('152.54'),
    total: dec('1000.00'),
    ...overrides,
  };
}

const pos = (overrides = {}) => normalizeRvieDocument(rvieRaw(overrides));

function classes(result: ReconciliationResult): ReconciliationClassification[] {
  return result.items.map((item) => item.classification);
}

describe('computeReconciliation — clasificación', () => {
  it('MATCHED cuando todo coincide (nombre sin acentos ni mayúsculas)', () => {
    const result = computeReconciliation(
      'RVIE',
      [pos({ customerName: 'Cliente Ñandú SAC' })],
      [row({ cpName: 'CLIENTE NANDU  SAC' })],
    );
    expect(classes(result)).toEqual(['MATCHED']);
    expect(result.items[0].differences).toEqual([]);
  });

  it('empareja con número con ceros a la izquierda', () => {
    const result = computeReconciliation(
      'RVIE',
      [pos({ number: 12 })],
      [row({ number: '12' })],
    );
    expect(classes(result)).toEqual(['MATCHED']);
  });

  it('MISSING_IN_POS y MISSING_IN_PROPOSAL', () => {
    const result = computeReconciliation(
      'RVIE',
      [pos()],
      [row({ number: '2' })],
    );
    expect(classes(result).sort()).toEqual([
      'MISSING_IN_POS',
      'MISSING_IN_PROPOSAL',
    ]);
  });

  it('AMOUNT_MISMATCH lista base, IGV y total con su diferencia exacta', () => {
    const result = computeReconciliation(
      'RVIE',
      [pos()],
      [
        row({
          taxableBase: dec('932.20'),
          igv: dec('167.80'),
          total: dec('1100.00'),
        }),
      ],
    );
    const item = result.items[0];
    expect(item.classification).toBe('AMOUNT_MISMATCH');
    expect(item.differences).toEqual([
      {
        field: 'taxableBase',
        pos: '847.46',
        proposal: '932.20',
        delta: '84.74',
      },
      { field: 'igv', pos: '152.54', proposal: '167.80', delta: '15.26' },
      { field: 'total', pos: '1000.00', proposal: '1100.00', delta: '100.00' },
    ]);
  });

  it('la comparación es exacta: 0.01 de diferencia es AMOUNT_MISMATCH', () => {
    const result = computeReconciliation(
      'RVIE',
      [pos()],
      [row({ total: dec('1000.01') })],
    );
    expect(classes(result)).toEqual(['AMOUNT_MISMATCH']);
    expect(result.items[0].differences[0]).toMatchObject({
      field: 'total',
      delta: '0.01',
    });
  });

  it('PARTY_MISMATCH por documento o nombre; AMOUNT tiene precedencia', () => {
    expect(
      classes(
        computeReconciliation('RVIE', [pos()], [row({ cpName: 'OTRO' })]),
      ),
    ).toEqual(['PARTY_MISMATCH']);
    expect(
      classes(
        computeReconciliation(
          'RVIE',
          [pos()],
          [row({ cpDocNumber: '99999000099' })],
        ),
      ),
    ).toEqual(['PARTY_MISMATCH']);
    const both = computeReconciliation(
      'RVIE',
      [pos()],
      [row({ cpName: 'OTRO', total: dec('1.00') })],
    );
    expect(classes(both)).toEqual(['AMOUNT_MISMATCH']);
    expect(both.items[0].differences.map((d) => d.field)).toEqual(
      expect.arrayContaining(['total', 'counterpartyName']),
    );
  });

  it('DATE_MISMATCH cuando solo difiere la fecha', () => {
    const result = computeReconciliation(
      'RVIE',
      [pos()],
      [row({ issueDate: '2026-01-06' })],
    );
    expect(classes(result)).toEqual(['DATE_MISMATCH']);
  });

  it('DUPLICATE_IN_PROPOSAL: cuenta apariciones y suma el excedente aparte', () => {
    const result = computeReconciliation(
      'RVIE',
      [pos()],
      [row({ lineNumber: 1 }), row({ lineNumber: 2 }), row({ lineNumber: 3 })],
    );
    expect(classes(result)).toEqual(['DUPLICATE_IN_PROPOSAL']);
    const item = result.items[0];
    expect(item.proposal?.occurrences).toBe(3);
    expect(item.proposal?.lineNumbers).toEqual([1, 2, 3]);
    expect(item.proposal?.duplicateSurplusTotal.toFixed(2)).toBe('2000.00');
    expect(item.differences).toEqual([]);
    expect(result.summary.totals.proposalDistinct.toFixed(2)).toBe('1000.00');
    expect(result.summary.totals.proposalRaw.toFixed(2)).toBe('3000.00');
  });

  it('INSUFFICIENT_DATA: documento sin clave (tipo sin mapear) y moneda no soportada', () => {
    const result = computeReconciliation(
      'RCE',
      [
        normalizeRceDocument(rceRaw({ refId: 'a', documentType: 'RECIBO' })),
        normalizeRceDocument(
          rceRaw({ refId: 'b', documentNumber: '2', currencyCode: 'USD' }),
        ),
      ],
      [],
    );
    expect(classes(result)).toEqual(['INSUFFICIENT_DATA', 'INSUFFICIENT_DATA']);
    expect(
      result.items.every((i) => i.key === null && i.proposal === null),
    ).toBe(true);
    // USD nunca se suma ni se convierte; PEN sí.
    expect(result.summary.totals.pos.toFixed(2)).toBe('1000.00');
    expect(result.summary.foreignCurrencyDocuments).toEqual([
      { currencyCode: 'USD', documents: 1 },
    ]);
  });

  it('INSUFFICIENT_DATA cuando coincide pero el tratamiento tributario es desconocido', () => {
    const unclassified = pos({
      taxableBase: dec('1000.00'),
      taxAmount: dec('0.00'),
    });
    const result = computeReconciliation(
      'RVIE',
      [unclassified],
      [row({ taxableBase: dec('1000.00'), igv: dec('0.00') })],
    );
    expect(classes(result)).toEqual(['INSUFFICIENT_DATA']);
    // Con base sin clasificar solo se compara el total.
    const mismatch = computeReconciliation(
      'RVIE',
      [unclassified],
      [row({ total: dec('1001.00') })],
    );
    expect(classes(mismatch)).toEqual(['AMOUNT_MISMATCH']);
    expect(mismatch.items[0].differences.map((d) => d.field)).toEqual([
      'total',
    ]);
  });

  it('una clave POS repetida nunca se concilia (DUPLICATE_POS_KEY)', () => {
    const result = computeReconciliation(
      'RVIE',
      [pos({ refId: 'a' }), pos({ refId: 'b' })],
      [row()],
    );
    expect(result.items.filter((i) => i.pos).length).toBe(2);
    expect(
      result.items.some(
        (i) =>
          i.classification === 'INSUFFICIENT_DATA' &&
          i.pos?.flags.includes('DUPLICATE_POS_KEY'),
      ),
    ).toBe(true);
    expect(
      result.items.some((i) => i.classification === 'MISSING_IN_POS'),
    ).toBe(true);
  });

  it('RCE: la clave incluye al proveedor', () => {
    const result = computeReconciliation(
      'RCE',
      [normalizeRceDocument(rceRaw())],
      [
        row({
          series: 'E001',
          number: '101',
          cpDocNumber: '99999100002',
          cpName: 'OTRO',
        }),
      ],
    );
    expect(classes(result).sort()).toEqual([
      'MISSING_IN_POS',
      'MISSING_IN_PROPOSAL',
    ]);
  });
});

describe('computeReconciliation — invariantes (pruebas de propiedad con semilla fija)', () => {
  /** PRNG determinista (mulberry32) para que la prueba sea reproducible. */
  function prng(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function scenario(seed: number) {
    const rnd = prng(seed);
    const int = (n: number): number => Math.floor(rnd() * n);
    const amounts = ['100.00', '250.50', '1000.00', '999.99'];

    const posDocs = Array.from({ length: int(25) }, (_, i) => {
      const total = amounts[int(amounts.length)];
      const taxed = rnd() > 0.2;
      return normalizeRvieDocument(
        rvieRaw({
          refId: `pos-${i}`,
          documentType: rnd() > 0.3 ? 'FACTURA' : 'BOLETA',
          series: rnd() > 0.5 ? 'F001' : 'B001',
          number: 1 + int(12),
          currencyCode: rnd() > 0.85 ? 'USD' : 'PEN',
          total: dec(total),
          taxableBase: taxed
            ? dec((Number(total) / 1.18).toFixed(2))
            : dec(total),
          taxAmount: taxed
            ? dec(
                (
                  Number(total) - Number((Number(total) / 1.18).toFixed(2))
                ).toFixed(2),
              )
            : dec('0.00'),
        }),
      );
    });

    const rows: ProposalRow[] = Array.from({ length: int(30) }, (_, i) =>
      row({
        lineNumber: i + 1,
        docTypeCode: rnd() > 0.3 ? '01' : '03',
        series: rnd() > 0.5 ? 'F001' : 'B001',
        number: String(1 + int(12)),
        total: dec(amounts[int(amounts.length)]),
        cpName: rnd() > 0.8 ? 'OTRO' : 'DEMO CLIENTE 1 SAC',
      }),
    );
    return { rnd, posDocs, rows };
  }

  const SEEDS = Array.from({ length: 60 }, (_, i) => 1000 + i * 7);

  it.each(SEEDS)('semilla %i: I1-I11 se cumplen', (seed) => {
    const { posDocs, rows } = scenario(seed);
    const result = computeReconciliation('RVIE', posDocs, rows);
    const { summary, items } = result;

    // I3
    const classCount = RECONCILIATION_CLASSIFICATIONS.reduce(
      (acc, c) => acc + summary.byClassification[c].count,
      0,
    );
    expect(items.length).toBe(summary.total);
    expect(classCount).toBe(summary.total);
    expect(result.counts).toEqual({
      posDocuments: posDocs.length,
      proposalRows: rows.length,
      items: items.length,
    });

    // I1: cada documento POS en exactamente un ítem.
    const posRefs = items
      .filter((i) => i.pos)
      .map((i) => (i.pos as { refId: string }).refId);
    expect(posRefs.sort()).toEqual(posDocs.map((d) => d.refId).sort());

    // I2: cada fila de la propuesta en exactamente un ítem.
    expect(
      items.reduce((acc, i) => acc + (i.proposal?.occurrences ?? 0), 0),
    ).toBe(rows.length);
    const lineRefs = items.flatMap((i) => i.proposal?.lineNumbers ?? []);
    expect(new Set(lineRefs).size).toBe(rows.length);

    // I5
    for (const item of items) {
      if (item.proposal) {
        expect(item.proposal.occurrences >= 2).toBe(
          item.classification === 'DUPLICATE_IN_PROPOSAL',
        );
      }
      if (item.classification === 'MISSING_IN_POS') expect(item.pos).toBeNull();
      if (item.classification === 'MISSING_IN_PROPOSAL')
        expect(item.proposal).toBeNull();
      // I7
      if (item.classification === 'MATCHED') {
        expect(item.differences).toEqual([]);
        expect(item.pos?.flags).not.toContain('TAX_TREATMENT_UNCLASSIFIED');
      }
    }

    // I8-I11: totales independientes calculados a mano.
    const sum = (values: Prisma.Decimal[]): Prisma.Decimal =>
      values.reduce((a, v) => a.plus(v), new Prisma.Decimal(0));
    const expectedPos = sum(
      posDocs.filter((d) => d.currencyCode === 'PEN').map((d) => d.total),
    );
    const expectedRaw = sum(rows.map((r) => r.total));
    const firstByKey = new Map<string, ProposalRow>();
    for (const r of [...rows].sort((a, b) => a.lineNumber - b.lineNumber)) {
      const k = `${r.docTypeCode}|${r.series}|${r.number}`;
      if (!firstByKey.has(k)) firstByKey.set(k, r);
    }
    const expectedDistinct = sum([...firstByKey.values()].map((r) => r.total));

    expect(summary.totals.pos.toFixed(2)).toBe(expectedPos.toFixed(2));
    expect(summary.totals.proposalDistinct.toFixed(2)).toBe(
      expectedDistinct.toFixed(2),
    );
    expect(summary.totals.proposalRaw.toFixed(2)).toBe(expectedRaw.toFixed(2));
    expect(
      summary.totals.duplicateSurplus
        .plus(summary.totals.proposalDistinct)
        .toFixed(2),
    ).toBe(expectedRaw.toFixed(2));
    expect(summary.totals.delta.toFixed(2)).toBe(
      expectedDistinct.minus(expectedPos).toFixed(2),
    );
    // I10: la suma por clase reconstruye el total general.
    const byPos = sum(
      RECONCILIATION_CLASSIFICATIONS.map(
        (c) => summary.byClassification[c].posTotal,
      ),
    );
    const byProposal = sum(
      RECONCILIATION_CLASSIFICATIONS.map(
        (c) => summary.byClassification[c].proposalTotal,
      ),
    );
    expect(byPos.toFixed(2)).toBe(summary.totals.pos.toFixed(2));
    expect(byProposal.toFixed(2)).toBe(
      summary.totals.proposalDistinct.toFixed(2),
    );
    // I11: monedas separadas.
    const foreign = posDocs.filter((d) => d.currencyCode !== 'PEN').length;
    expect(
      summary.foreignCurrencyDocuments.reduce((a, f) => a + f.documents, 0),
    ).toBe(foreign);
  });

  it.each(SEEDS.slice(0, 20))(
    'semilla %i: el resultado no depende del orden de entrada',
    (seed) => {
      const { rnd, posDocs, rows } = scenario(seed);
      const shuffle = <T>(list: T[]): T[] => [...list].sort(() => rnd() - 0.5);
      const a = computeReconciliation('RVIE', posDocs, rows);
      const b = computeReconciliation('RVIE', shuffle(posDocs), shuffle(rows));
      expect(b.resultDigest).toBe(a.resultDigest);
      expect(b.items.map((i) => i.classification)).toEqual(
        a.items.map((i) => i.classification),
      );
    },
  );

  it('el digest cambia cuando cambia un monto', () => {
    const base = computeReconciliation('RVIE', [pos()], [row()]);
    const changed = computeReconciliation(
      'RVIE',
      [pos()],
      [row({ total: dec('1000.01') })],
    );
    expect(changed.resultDigest).not.toBe(base.resultDigest);
  });
});

import { parseDemoProposal } from '../core/demo-proposal.parser';
import { normalizeRawDocument } from '../core/normalizer';
import { computeReconciliation } from '../core/reconciliation.engine';
import { SireRegister } from '../core/types';
import { FixtureTaxDocumentSource } from '../sources/fixture-tax-document.source';
import { DEMO_FIXTURES_V1 } from './demo-fixtures-v1';
import { computeFixtureSetDigest } from './fixture-set';
import {
  CURRENT_FIXTURE_SET,
  getFixtureSet,
  supportedFixtureVersions,
} from './fixture-registry';

describe('versionado de fixtures', () => {
  it('el digest declarado coincide con el contenido (inmutabilidad)', () => {
    expect(DEMO_FIXTURES_V1.digest).toBe(
      computeFixtureSetDigest(DEMO_FIXTURES_V1),
    );
  });

  it('editar el contenido sin cambiar la versión cambia el digest', () => {
    const tampered = {
      ...DEMO_FIXTURES_V1,
      sampleFiles: {
        ...DEMO_FIXTURES_V1.sampleFiles,
        RVIE: {
          ...DEMO_FIXTURES_V1.sampleFiles.RVIE,
          content: DEMO_FIXTURES_V1.sampleFiles.RVIE.content.replace(
            '1000.00',
            '1000.01',
          ),
        },
      },
    };
    expect(computeFixtureSetDigest(tampered)).not.toBe(DEMO_FIXTURES_V1.digest);
  });

  it('el registro resuelve solo versiones conocidas', () => {
    expect(CURRENT_FIXTURE_SET.version).toBe('demo-fixtures-v1');
    expect(getFixtureSet('demo-fixtures-v1')).toBe(DEMO_FIXTURES_V1);
    expect(getFixtureSet('demo-fixtures-v0')).toBeUndefined();
    expect(supportedFixtureVersions()).toEqual(['demo-fixtures-v1']);
  });

  it('una versión desconocida RECHAZA y nunca recurre a otra', async () => {
    await expect(
      new FixtureTaxDocumentSource().load('RVIE', '202601', 'demo-fixtures-v0'),
    ).rejects.toThrow('demo-fixtures-v0');
  });
});

describe('fixtures v1: el motor real produce los escenarios (nada hardcodeado)', () => {
  async function run(register: SireRegister) {
    const source = new FixtureTaxDocumentSource();
    const loaded = await source.load(register, '202601');
    const normalized = loaded.documents.map(normalizeRawDocument);
    const parsed = parseDemoProposal(
      CURRENT_FIXTURE_SET.sampleFiles[register].content,
      {
        expected: { source: 'DEMO_FIXTURES', register, period: '202601' },
      },
    );
    if (!parsed.ok) {
      throw new Error(`Fixture inválido: ${JSON.stringify(parsed.errors)}`);
    }
    expect(parsed.header.fixtureSetVersion).toBe('demo-fixtures-v1');
    return {
      loaded,
      normalized,
      parsed,
      result: computeReconciliation(register, normalized, parsed.rows),
    };
  }

  it.each([
    ['RVIE', 15, 15],
    ['RCE', 14, 15],
  ] as const)(
    '%s: 14 documentos POS, %i filas, %i ítems y conteos por clase',
    async (register, rows, items) => {
      const { loaded, normalized, parsed, result } = await run(register);
      expect(normalized).toHaveLength(14);
      expect(loaded.excluded).toEqual({
        notEligibleStatus: 2,
        salesWithoutFiscalDocument: null,
      });
      expect(parsed.rows).toHaveLength(rows);
      expect(result.counts).toEqual({
        posDocuments: 14,
        proposalRows: rows,
        items,
      });

      const byClass = Object.fromEntries(
        Object.entries(result.summary.byClassification).map(([k, v]) => [
          k,
          v.count,
        ]),
      );
      expect(byClass).toEqual({
        MATCHED: 8,
        MISSING_IN_POS: 1,
        MISSING_IN_PROPOSAL: 1,
        AMOUNT_MISMATCH: 1,
        PARTY_MISMATCH: 1,
        DATE_MISMATCH: 1,
        DUPLICATE_IN_PROPOSAL: 1,
        INSUFFICIENT_DATA: 1,
      });
    },
  );

  // RVIE: el documento con datos insuficientes SÍ tiene fila en la propuesta (15 filas).
  // RCE: el RECIBO no tiene clave y no tiene fila (14 filas), por eso su total único es menor.
  it.each([
    [
      'RVIE',
      '14000.00',
      '13600.00',
      '1000.00',
      '14600.00',
      '-400.00',
      ['1000.00', '1000.00'],
    ],
    [
      'RCE',
      '14000.00',
      '12600.00',
      '1000.00',
      '13600.00',
      '-1400.00',
      ['1000.00', '0.00'],
    ],
  ] as const)(
    '%s: totales exactos y sin duplicar montos',
    async (register, pos, distinct, surplus, raw, delta, insufficient) => {
      const { result } = await run(register);
      const { totals } = result.summary;
      expect(totals.pos.toFixed(2)).toBe(pos);
      expect(totals.proposalDistinct.toFixed(2)).toBe(distinct);
      expect(totals.duplicateSurplus.toFixed(2)).toBe(surplus);
      expect(totals.proposalRaw.toFixed(2)).toBe(raw);
      expect(totals.delta.toFixed(2)).toBe(delta);
      const money = (
        c: keyof typeof result.summary.byClassification,
      ): [string, string] => [
        result.summary.byClassification[c].posTotal.toFixed(2),
        result.summary.byClassification[c].proposalTotal.toFixed(2),
      ];
      expect(money('MATCHED')).toEqual(['8000.00', '8000.00']);
      expect(money('MISSING_IN_POS')).toEqual(['0.00', '500.00']);
      expect(money('MISSING_IN_PROPOSAL')).toEqual(['1000.00', '0.00']);
      expect(money('AMOUNT_MISMATCH')).toEqual(['1000.00', '1100.00']);
      expect(money('DUPLICATE_IN_PROPOSAL')).toEqual(['1000.00', '1000.00']);
      expect(money('INSUFFICIENT_DATA')).toEqual(insufficient);
    },
  );

  it('RCE: el documento emitido en diciembre pertenece a enero por la regla accountingDate', async () => {
    const { normalized } = await run('RCE');
    const doc = normalized.find((d) => d.refId === 'fixture-rce-E001-108');
    expect(doc).toMatchObject({
      period: '202601',
      issueDate: '2025-12-28',
      accountingDate: '2026-01-12',
    });
  });

  it('RCE: el RECIBO queda sin clave y solo el origen decide los estados elegibles', async () => {
    const { result } = await run('RCE');
    const unkeyed = result.items.filter((i) => i.key === null);
    expect(unkeyed).toHaveLength(1);
    expect(unkeyed[0].pos?.flags).toContain('DOC_TYPE_UNMAPPED');
  });

  it('listPeriods informa un periodo por registro con documentos elegibles', async () => {
    const source = new FixtureTaxDocumentSource();
    expect(await source.listPeriods('RVIE')).toEqual([
      { period: '202601', documentCount: 14 },
    ]);
    expect(await source.listPeriods('RCE')).toEqual([
      { period: '202601', documentCount: 14 },
    ]);
  });

  it('un periodo sin fixtures devuelve vacío', async () => {
    const loaded = await new FixtureTaxDocumentSource().load('RVIE', '202602');
    expect(loaded.documents).toEqual([]);
    expect(loaded.excluded.notEligibleStatus).toBe(0);
  });
});

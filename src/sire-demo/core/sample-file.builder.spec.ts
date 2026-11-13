import { parseDemoProposal } from './demo-proposal.parser';
import { normalizeRceDocument, normalizeRvieDocument } from './normalizer';
import { computeReconciliation } from './reconciliation.engine';
import { buildPosDerivedSampleFile } from './sample-file.builder';
import { dec, rceRaw, rvieRaw } from './test-helpers';

function docs(count: number) {
  return Array.from({ length: count }, (_, i) =>
    normalizeRvieDocument(
      rvieRaw({
        refId: `d-${i + 1}`,
        number: i + 1,
        customerDocumentNumber: `9999900${String(i + 1).padStart(4, '0')}`,
        customerName: `DEMO CLIENTE ${i + 1} SAC`,
      }),
    ),
  );
}

describe('buildPosDerivedSampleFile', () => {
  it('devuelve null si ningún documento es representable', () => {
    expect(
      buildPosDerivedSampleFile({
        register: 'RVIE',
        period: '202601',
        documents: [],
      }),
    ).toBeNull();
    const usd = normalizeRvieDocument(rvieRaw({ currencyCode: 'USD' }));
    expect(
      buildPosDerivedSampleFile({
        register: 'RVIE',
        period: '202601',
        documents: [usd],
      }),
    ).toBeNull();
  });

  it('produce un archivo DEMO_V1 válido con origen POS', () => {
    const content = buildPosDerivedSampleFile({
      register: 'RVIE',
      period: '202601',
      documents: docs(12),
    });
    expect(content?.split('\n')[0]).toBe(
      '#DEMO_V1|SOURCE=POS|REGISTER=RVIE|PERIOD=202601',
    );
    const parsed = parseDemoProposal(content as string, {
      expected: { source: 'POS', register: 'RVIE', period: '202601' },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.header.fixtureSetVersion).toBeNull();
  });

  it('las mutaciones deterministas producen las clases esperadas al conciliar', () => {
    const documents = docs(12);
    const content = buildPosDerivedSampleFile({
      register: 'RVIE',
      period: '202601',
      documents,
    }) as string;
    const parsed = parseDemoProposal(content);
    if (!parsed.ok) throw new Error('archivo inválido');
    const result = computeReconciliation('RVIE', documents, parsed.rows);
    const count = (c: string): number =>
      result.items.filter((i) => i.classification === c).length;
    // Índices 2 y 9 cambian el total; 4 cambia el nombre; el 11 (último) se omite;
    // la primera fila se repite y se agrega una fila ZZ99 inexistente en el POS.
    expect(count('AMOUNT_MISMATCH')).toBe(2);
    expect(count('PARTY_MISMATCH')).toBe(1);
    expect(count('MISSING_IN_PROPOSAL')).toBe(1);
    expect(count('MISSING_IN_POS')).toBe(1);
    expect(count('DUPLICATE_IN_PROPOSAL')).toBe(1);
    expect(count('MATCHED')).toBe(7);
  });

  it('es determinista', () => {
    const a = buildPosDerivedSampleFile({
      register: 'RVIE',
      period: '202601',
      documents: docs(9),
    });
    const b = buildPosDerivedSampleFile({
      register: 'RVIE',
      period: '202601',
      documents: [...docs(9)].reverse(),
    });
    expect(b).toBe(a);
  });

  it('con un solo documento no lo omite', () => {
    const content = buildPosDerivedSampleFile({
      register: 'RVIE',
      period: '202601',
      documents: docs(1),
    }) as string;
    const parsed = parseDemoProposal(content);
    expect(parsed.ok && parsed.rows.map((r) => r.series)).toEqual([
      'F001',
      'F001',
      'ZZ99',
    ]);
  });

  it('descarta documentos que el parser rechazaría (tipos sin mapear) y limpia el nombre', () => {
    const good = normalizeRceDocument(
      rceRaw({ refId: 'ok', supplierLegalName: 'A|B\tC' }),
    );
    const unmapped = normalizeRceDocument(
      rceRaw({ refId: 'no', documentType: 'RECIBO', documentNumber: '9' }),
    );
    const foreign = normalizeRceDocument(
      rceRaw({
        refId: 'fx',
        documentNumber: '8',
        supplierDocumentType: 'FOREIGN_TAX_ID',
      }),
    );
    const content = buildPosDerivedSampleFile({
      register: 'RCE',
      period: '202601',
      documents: [good, unmapped, foreign],
    }) as string;
    const parsed = parseDemoProposal(content);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.rows.map((r) => r.number)).toEqual([
      '101',
      '101',
      '1',
    ]);
    expect(parsed.ok && parsed.rows[0].cpName).toBe('A B C');
  });

  it('base sin clasificar se escribe en cero y no genera diferencia de monto', () => {
    const [first, , third] = docs(3);
    const unclassified = normalizeRvieDocument(
      rvieRaw({
        refId: 'd-2',
        number: 2,
        taxableBase: dec('1000.00'),
        taxAmount: dec('0.00'),
      }),
    );
    const documents = [first, unclassified, third];
    const content = buildPosDerivedSampleFile({
      register: 'RVIE',
      period: '202601',
      documents,
    }) as string;
    expect(content).toContain('|PEN|0.00|0.00|1000.00');
    const parsed = parseDemoProposal(content);
    if (!parsed.ok) throw new Error('archivo inválido');
    const result = computeReconciliation('RVIE', documents, parsed.rows);
    const item = result.items.find((i) => i.pos?.refId === 'd-2');
    expect(item?.classification).toBe('INSUFFICIENT_DATA');
    expect(item?.differences).toEqual([]);
  });
});

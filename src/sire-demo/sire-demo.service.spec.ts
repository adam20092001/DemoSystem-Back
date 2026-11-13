import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { parseDemoProposal } from './core/demo-proposal.parser';
import { normalizeRawDocument } from './core/normalizer';
import { computeReconciliation } from './core/reconciliation.engine';
import { rvieRaw } from './core/test-helpers';
import { CURRENT_FIXTURE_SET } from './fixtures/fixture-registry';
import { SireDemoFlags } from './sire-demo.flags';
import { SireDemoService } from './sire-demo.service';
import { FixtureTaxDocumentSource } from './sources/fixture-tax-document.source';
import { PosTaxDocumentSource } from './sources/pos-tax-document.source';

const ON: SireDemoFlags = {
  enabled: true,
  fixturesEnabled: true,
  allowInProduction: false,
  production: false,
};
const NO_FIXTURES: SireDemoFlags = { ...ON, fixturesEnabled: false };

function build(flags: SireDemoFlags = ON) {
  const pos = {
    source: 'POS' as const,
    listPeriods: jest.fn().mockResolvedValue([]),
    load: jest.fn().mockResolvedValue({
      documents: [],
      excluded: { notEligibleStatus: 0, salesWithoutFiscalDocument: 0 },
    }),
  };
  const fixtures = new FixtureTaxDocumentSource();
  const fixturesLoad = jest.spyOn(fixtures, 'load');
  const service = new SireDemoService(
    flags,
    pos as unknown as PosTaxDocumentSource,
    fixtures,
  );
  return { service, pos, fixtures, fixturesLoad };
}

const query = (over: Record<string, unknown> = {}) =>
  ({ source: 'DEMO_FIXTURES', period: '202601', ...over }) as never;

describe('SireDemoService.getContext', () => {
  it('informa modo DEMO, límites y los periodos de cada origen por separado', async () => {
    const { service, pos } = build();
    pos.listPeriods.mockResolvedValue([]);
    const ctx = await service.getContext();

    expect(ctx).toMatchObject({
      mode: 'DEMO',
      officialValidity: false,
      formatVersion: 'DEMO_V1',
      limits: { maxFileBytes: 2097152, maxRows: 5000 },
    });
    expect(ctx.disclaimer).toContain('Sin validez ante SUNAT');
    const [posInfo, fixtureInfo] = ctx.sources;
    expect(posInfo).toMatchObject({
      source: 'POS',
      available: true,
      fixtureSetVersion: null,
      isEmpty: true,
    });
    expect(fixtureInfo).toMatchObject({
      source: 'DEMO_FIXTURES',
      available: true,
      fixtureSetVersion: 'demo-fixtures-v1',
      supportedFixtureVersions: ['demo-fixtures-v1'],
      isEmpty: false,
      registers: {
        RVIE: { periods: [{ period: '202601', documentCount: 14 }] },
        RCE: { periods: [{ period: '202601', documentCount: 14 }] },
      },
    });
  });

  it('con fixtures deshabilitados el origen figura no disponible y sin periodos', async () => {
    const { service, fixturesLoad } = build(NO_FIXTURES);
    const ctx = await service.getContext();
    expect(ctx.sources[1]).toEqual({
      source: 'DEMO_FIXTURES',
      available: false,
      fixtureSetVersion: null,
      supportedFixtureVersions: [],
      isEmpty: true,
      registers: { RVIE: { periods: [] }, RCE: { periods: [] } },
    });
    expect(fixturesLoad).not.toHaveBeenCalled();
  });

  it('un POS con datos no está vacío', async () => {
    const { service, pos } = build();
    pos.listPeriods.mockImplementation((register: string) =>
      Promise.resolve(
        register === 'RVIE' ? [{ period: '202611', documentCount: 3 }] : [],
      ),
    );
    const ctx = await service.getContext();
    expect(ctx.sources[0].isEmpty).toBe(false);
    expect(ctx.sources[0].registers.RVIE.periods).toEqual([
      { period: '202611', documentCount: 3 },
    ]);
  });
});

describe('SireDemoService.getDocuments', () => {
  it('RVIE fixtures: totales por moneda, alertas y excluidos', async () => {
    const { service } = build();
    const res = await service.getDocuments('RVIE', query());

    expect(res).toMatchObject({
      mode: 'DEMO',
      officialValidity: false,
      formatVersion: 'DEMO_V1',
      source: 'DEMO_FIXTURES',
      fixtureSetVersion: 'demo-fixtures-v1',
      register: 'RVIE',
      period: '202601',
      periodRule: 'issueDate (America/Lima) - PROVISIONAL (DEMO)',
      page: 1,
      pageSize: 50,
      totalItems: 14,
    });
    expect(res.summary.documentCount).toBe(14);
    expect(res.summary.excluded).toEqual({
      notEligibleStatus: 2,
      salesWithoutFiscalDocument: null,
    });
    expect(res.summary.totalsByCurrency).toEqual({
      PEN: {
        documents: 14,
        taxableBase: '11016.98',
        igv: '1983.02',
        unclassifiedTotal: '1000.00',
        total: '14000.00',
      },
    });
    expect(res.summary.flags.TAX_TREATMENT_UNCLASSIFIED).toBe(1);
    expect(res.items).toHaveLength(14);
    expect(res.items[0]).toMatchObject({
      key: { docTypeCode: '01', series: 'F001', number: '1' },
      internalStatus: 'ACCEPTED_MOCK',
      taxableBase: '847.46',
      igv: '152.54',
      total: '1000.00',
    });
  });

  it('invariante I14: total = base + IGV + sin clasificar (sin alertas aritméticas)', async () => {
    const { service } = build();
    for (const register of ['RVIE', 'RCE'] as const) {
      const res = await service.getDocuments(register, query());
      const t = res.summary.totalsByCurrency.PEN;
      expect(res.summary.flags.ARITHMETIC_INCONSISTENT).toBe(0);
      expect(
        Number(t.taxableBase) + Number(t.igv) + Number(t.unclassifiedTotal),
      ).toBeCloseTo(Number(t.total), 2);
    }
  });

  it('RCE fixtures: periodo por accountingDate; el RECIBO queda sin código', async () => {
    const { service } = build();
    const res = await service.getDocuments('RCE', query());
    expect(res.periodRule).toBe('accountingDate - PROVISIONAL (DEMO)');
    expect(res.summary.documentCount).toBe(14);
    expect(res.summary.flags.DOC_TYPE_UNMAPPED).toBe(1);
    const december = res.items.find((i) => i.refId === 'fixture-rce-E001-108');
    expect(december).toMatchObject({
      issueDate: '2025-12-28',
      accountingDate: '2026-01-12',
    });
    const unkeyed = res.items.filter((i) => i.key === null);
    expect(unkeyed).toHaveLength(1);
    expect(res.items[res.items.length - 1].key).toBeNull();
  });

  it('pagina y filtra por alerta sin alterar el resumen del periodo', async () => {
    const { service } = build();
    const page2 = await service.getDocuments(
      'RVIE',
      query({ page: 2, pageSize: 5 }),
    );
    expect(page2.items).toHaveLength(5);
    expect(page2.totalItems).toBe(14);
    expect(page2.summary.documentCount).toBe(14);

    const flagged = await service.getDocuments(
      'RVIE',
      query({ flag: 'TAX_TREATMENT_UNCLASSIFIED' }),
    );
    expect(flagged.items.map((i) => i.refId)).toEqual(['fixture-rvie-B001-1']);
    expect(flagged.totalItems).toBe(1);
    expect(flagged.summary.documentCount).toBe(14);
    expect(flagged.summary.flags.TAX_TREATMENT_UNCLASSIFIED).toBe(1);

    const beyond = await service.getDocuments(
      'RVIE',
      query({ page: 9, pageSize: 5 }),
    );
    expect(beyond.items).toEqual([]);
  });

  it('un periodo sin documentos responde vacío, no error', async () => {
    const { service } = build();
    const res = await service.getDocuments('RVIE', query({ period: '202602' }));
    expect(res.summary).toMatchObject({
      documentCount: 0,
      totalsByCurrency: {},
    });
    expect(res.items).toEqual([]);
  });

  it('POS y DEMO_FIXTURES nunca se mezclan: cada consulta usa solo su origen', async () => {
    const { service, pos, fixturesLoad } = build();
    pos.load.mockResolvedValue({
      documents: [rvieRaw({ refId: 'pos-doc' })],
      excluded: { notEligibleStatus: 1, salesWithoutFiscalDocument: 4 },
    });

    const fromPos = await service.getDocuments(
      'RVIE',
      query({ source: 'POS' }),
    );
    expect(fromPos).toMatchObject({ source: 'POS', fixtureSetVersion: null });
    expect(fromPos.items.map((i) => i.refId)).toEqual(['pos-doc']);
    expect(fromPos.summary.excluded).toEqual({
      notEligibleStatus: 1,
      salesWithoutFiscalDocument: 4,
    });
    expect(fixturesLoad).not.toHaveBeenCalled();

    pos.load.mockClear();
    const fromFixtures = await service.getDocuments('RVIE', query());
    expect(fromFixtures.items.some((i) => i.refId === 'pos-doc')).toBe(false);
    expect(pos.load).not.toHaveBeenCalled();
  });

  it('sin moneda mezclada: otra moneda se totaliza aparte', async () => {
    const { service, pos } = build();
    pos.load.mockResolvedValue({
      documents: [
        rvieRaw({ refId: 'a' }),
        rvieRaw({ refId: 'b', number: 2, currencyCode: 'USD' }),
      ],
      excluded: { notEligibleStatus: 0, salesWithoutFiscalDocument: 0 },
    });
    const res = await service.getDocuments('RVIE', query({ source: 'POS' }));
    expect(Object.keys(res.summary.totalsByCurrency)).toEqual(['PEN', 'USD']);
    expect(res.summary.totalsByCurrency.PEN.total).toBe('1000.00');
    expect(res.summary.totalsByCurrency.USD.total).toBe('1000.00');
    expect(res.summary.flags.CURRENCY_UNSUPPORTED).toBe(1);
  });

  it('DEMO_FIXTURES deshabilitado: 403 con código estable y sin leer fixtures', async () => {
    const { service, fixturesLoad } = build(NO_FIXTURES);
    await expect(service.getDocuments('RVIE', query())).rejects.toThrow(
      ForbiddenException,
    );
    await service
      .getDocuments('RVIE', query())
      .catch((error: ForbiddenException) => {
        expect(error.getResponse()).toMatchObject({
          code: 'SIRE_SOURCE_DISABLED',
        });
      });
    expect(fixturesLoad).not.toHaveBeenCalled();
  });
});

describe('SireDemoService.getSampleFile', () => {
  it('fixtures: devuelve el archivo versionado, parseable y con el origen en la cabecera', async () => {
    const { service } = build();
    for (const register of ['RVIE', 'RCE'] as const) {
      const file = await service.getSampleFile(register, query());
      expect(file.fileName).toBe(
        `DEMO_V1_${register}_202601_DEMO_FIXTURES.txt`,
      );
      expect(file.content).toBe(
        CURRENT_FIXTURE_SET.sampleFiles[register].content,
      );
      expect(file.content.split('\n')[0]).toContain('SOURCE=DEMO_FIXTURES');
      expect(file.content.split('\n')[0]).toContain('FIXTURE=demo-fixtures-v1');
      expect(parseDemoProposal(file.content).ok).toBe(true);
    }
  });

  it('fixtures: un periodo fuera del conjunto responde 400 con código estable', async () => {
    const { service } = build();
    const promise = service.getSampleFile('RVIE', query({ period: '202602' }));
    await expect(promise).rejects.toThrow(BadRequestException);
    await promise.catch((error: BadRequestException) => {
      expect(error.getResponse()).toMatchObject({
        code: 'FIXTURE_PERIOD_UNAVAILABLE',
      });
    });
  });

  it('POS: deriva el archivo de los documentos reales y concilia contra ellos', async () => {
    const { service, pos } = build();
    const raws = Array.from({ length: 12 }, (_, i) =>
      rvieRaw({
        refId: `d-${i + 1}`,
        number: i + 1,
        customerDocumentNumber: `9999900${String(i + 1).padStart(4, '0')}`,
      }),
    );
    pos.load.mockResolvedValue({
      documents: raws,
      excluded: { notEligibleStatus: 0, salesWithoutFiscalDocument: 0 },
    });

    const file = await service.getSampleFile('RVIE', query({ source: 'POS' }));
    expect(file.fileName).toBe('DEMO_V1_RVIE_202601_POS.txt');
    expect(file.content.split('\n')[0]).toBe(
      '#DEMO_V1|SOURCE=POS|REGISTER=RVIE|PERIOD=202601',
    );
    const parsed = parseDemoProposal(file.content);
    if (!parsed.ok) throw new Error('archivo inválido');
    const result = computeReconciliation(
      'RVIE',
      raws.map(normalizeRawDocument),
      parsed.rows,
    );
    expect(result.summary.byClassification.AMOUNT_MISMATCH.count).toBe(2);
    expect(result.summary.byClassification.MISSING_IN_POS.count).toBe(1);
  });

  it('POS sin documentos representables: 409 POS_SOURCE_EMPTY', async () => {
    const { service } = build();
    const promise = service.getSampleFile('RVIE', query({ source: 'POS' }));
    await expect(promise).rejects.toThrow(ConflictException);
    await promise.catch((error: ConflictException) => {
      expect(error.getResponse()).toMatchObject({ code: 'POS_SOURCE_EMPTY' });
    });
  });

  it('DEMO_FIXTURES deshabilitado también bloquea el archivo de ejemplo', async () => {
    const { service } = build(NO_FIXTURES);
    await expect(service.getSampleFile('RVIE', query())).rejects.toThrow(
      ForbiddenException,
    );
  });
});

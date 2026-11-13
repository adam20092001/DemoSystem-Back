import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { compareNormalizedDocuments, documentKeyOf } from './core/document-key';
import { normalizeRawDocument } from './core/normalizer';
import { RCE_PERIOD_RULE, RVIE_PERIOD_RULE } from './core/period';
import { buildPosDerivedSampleFile } from './core/sample-file.builder';
import {
  DATA_QUALITY_FLAGS,
  DataQualityFlag,
  NormalizedTaxDocument,
  SireRegister,
  SireSource,
} from './core/types';
import {
  SireContextResponseDto,
  SireCurrencyTotalsDto,
  SireDocumentItemDto,
  SireDocumentsResponseDto,
  SireDocumentsSummaryDto,
  SireSourceInfoDto,
} from './dto/sire-demo-response.dto';
import {
  SireDocumentsQueryDto,
  SireSampleFileQueryDto,
} from './dto/sire-demo-query.dto';
import {
  CURRENT_FIXTURE_SET,
  supportedFixtureVersions,
} from './fixtures/fixture-registry';
import {
  SIRE_DEMO_DISCLAIMER,
  SIRE_DEMO_DEFAULT_PAGE_SIZE,
  SIRE_DEMO_FLAGS,
  SIRE_DEMO_FORMAT_VERSION,
  SIRE_DEMO_MAX_FILE_BYTES,
  SIRE_DEMO_MAX_ROWS,
  SIRE_DEMO_MODE,
} from './sire-demo.constants';
import type { SireDemoFlags } from './sire-demo.flags';
import { FixtureTaxDocumentSource } from './sources/fixture-tax-document.source';
import { PosTaxDocumentSource } from './sources/pos-tax-document.source';
import { TaxDocumentSource } from './sources/tax-document-source';

const ZERO = new Prisma.Decimal(0);

/** Alertas que calcula el normalizador (DUPLICATE_POS_KEY es exclusiva del motor). */
const DOCUMENT_FLAGS: readonly DataQualityFlag[] = DATA_QUALITY_FLAGS.filter(
  (flag) => flag !== 'DUPLICATE_POS_KEY',
);

export interface SampleFile {
  fileName: string;
  content: string;
}

function envelope(): {
  mode: typeof SIRE_DEMO_MODE;
  officialValidity: false;
  formatVersion: typeof SIRE_DEMO_FORMAT_VERSION;
} {
  return {
    mode: SIRE_DEMO_MODE,
    officialValidity: false,
    formatVersion: SIRE_DEMO_FORMAT_VERSION,
  };
}

function toDocumentItem(doc: NormalizedTaxDocument): SireDocumentItemDto {
  return {
    refId: doc.refId,
    key: documentKeyOf(doc),
    docTypeCode: doc.docTypeCode,
    series: doc.series,
    number: doc.number,
    issueDate: doc.issueDate,
    accountingDate: doc.accountingDate,
    counterparty: doc.counterparty,
    currencyCode: doc.currencyCode,
    taxableBase: doc.taxableBase === null ? null : doc.taxableBase.toFixed(2),
    igv: doc.igv.toFixed(2),
    total: doc.total.toFixed(2),
    internalStatus: doc.internalStatus,
    flags: doc.flags,
  };
}

/**
 * Totales por moneda (nunca se suman monedas distintas) y conteo de alertas
 * sobre el conjunto COMPLETO del periodo. Invariante I14: por moneda,
 * total = taxableBase + igv + unclassifiedTotal, salvo documentos con la
 * alerta ARITHMETIC_INCONSISTENT (cuyo conteo se informa en `flags`).
 */
function summarize(
  docs: readonly NormalizedTaxDocument[],
  excluded: SireDocumentsSummaryDto['excluded'],
): SireDocumentsSummaryDto {
  const acc = new Map<
    string,
    {
      documents: number;
      base: Prisma.Decimal;
      igv: Prisma.Decimal;
      unclassified: Prisma.Decimal;
      total: Prisma.Decimal;
    }
  >();
  const flagCounts: Record<string, number> = {};
  for (const flag of DOCUMENT_FLAGS) {
    flagCounts[flag] = 0;
  }

  for (const doc of docs) {
    const entry = acc.get(doc.currencyCode) ?? {
      documents: 0,
      base: ZERO,
      igv: ZERO,
      unclassified: ZERO,
      total: ZERO,
    };
    entry.documents += 1;
    entry.igv = entry.igv.plus(doc.igv);
    entry.total = entry.total.plus(doc.total);
    if (doc.taxableBase === null) {
      entry.unclassified = entry.unclassified.plus(doc.total);
    } else {
      entry.base = entry.base.plus(doc.taxableBase);
    }
    acc.set(doc.currencyCode, entry);
    for (const flag of doc.flags) {
      flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
    }
  }

  const totalsByCurrency: Record<string, SireCurrencyTotalsDto> = {};
  for (const [currency, entry] of [...acc.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    totalsByCurrency[currency] = {
      documents: entry.documents,
      taxableBase: entry.base.toFixed(2),
      igv: entry.igv.toFixed(2),
      unclassifiedTotal: entry.unclassified.toFixed(2),
      total: entry.total.toFixed(2),
    };
  }

  return {
    documentCount: docs.length,
    excluded,
    totalsByCurrency,
    flags: flagCounts,
  };
}

@Injectable()
export class SireDemoService {
  constructor(
    @Inject(SIRE_DEMO_FLAGS) private readonly flags: SireDemoFlags,
    private readonly posSource: PosTaxDocumentSource,
    private readonly fixtureSource: FixtureTaxDocumentSource,
  ) {}

  async getContext(): Promise<SireContextResponseDto> {
    const sources = await Promise.all([
      this.describeSource('POS'),
      this.describeSource('DEMO_FIXTURES'),
    ]);
    return {
      ...envelope(),
      disclaimer: SIRE_DEMO_DISCLAIMER,
      limits: {
        maxFileBytes: SIRE_DEMO_MAX_FILE_BYTES,
        maxRows: SIRE_DEMO_MAX_ROWS,
      },
      sources,
    };
  }

  async getDocuments(
    register: SireRegister,
    query: SireDocumentsQueryDto,
  ): Promise<SireDocumentsResponseDto> {
    const source = this.sourceFor(query.source);
    const loaded = await source.load(register, query.period);

    const normalized = loaded.documents
      .map(normalizeRawDocument)
      .sort(compareNormalizedDocuments);
    const filtered =
      query.flag === undefined
        ? normalized
        : normalized.filter((doc) =>
            doc.flags.includes(query.flag as DataQualityFlag),
          );

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? SIRE_DEMO_DEFAULT_PAGE_SIZE;
    const slice = filtered.slice((page - 1) * pageSize, page * pageSize);

    return {
      ...envelope(),
      source: query.source,
      fixtureSetVersion: this.fixtureVersionOf(query.source),
      register,
      period: query.period,
      periodRule: register === 'RVIE' ? RVIE_PERIOD_RULE : RCE_PERIOD_RULE,
      summary: summarize(normalized, loaded.excluded),
      items: slice.map(toDocumentItem),
      page,
      pageSize,
      totalItems: filtered.length,
    };
  }

  async getSampleFile(
    register: SireRegister,
    query: SireSampleFileQueryDto,
  ): Promise<SampleFile> {
    const source = this.sourceFor(query.source);
    const fileName = `DEMO_V1_${register}_${query.period}_${query.source}.txt`;

    if (query.source === 'DEMO_FIXTURES') {
      const sample = CURRENT_FIXTURE_SET.sampleFiles[register];
      if (sample.period !== query.period) {
        throw new BadRequestException({
          message: `El conjunto de fixtures ${CURRENT_FIXTURE_SET.version} solo incluye el periodo ${sample.period} para ${register}.`,
          error: 'Bad Request',
          code: 'FIXTURE_PERIOD_UNAVAILABLE',
        });
      }
      return { fileName, content: sample.content };
    }

    const loaded = await source.load(register, query.period);
    const content = buildPosDerivedSampleFile({
      register,
      period: query.period,
      documents: loaded.documents.map(normalizeRawDocument),
    });
    if (content === null) {
      throw new ConflictException({
        message:
          'El origen POS no tiene documentos representables en ese periodo. Usa source=DEMO_FIXTURES para obtener datos de demostración.',
        error: 'Conflict',
        code: 'POS_SOURCE_EMPTY',
      });
    }
    return { fileName, content };
  }

  private sourceFor(source: SireSource): TaxDocumentSource {
    if (source === 'DEMO_FIXTURES') {
      if (!this.flags.fixturesEnabled) {
        throw new ForbiddenException({
          message:
            'El origen DEMO_FIXTURES no está habilitado en este ambiente.',
          error: 'Forbidden',
          code: 'SIRE_SOURCE_DISABLED',
        });
      }
      return this.fixtureSource;
    }
    return this.posSource;
  }

  private fixtureVersionOf(source: SireSource): string | null {
    return source === 'DEMO_FIXTURES' ? CURRENT_FIXTURE_SET.version : null;
  }

  private async describeSource(source: SireSource): Promise<SireSourceInfoDto> {
    const available = source === 'POS' || this.flags.fixturesEnabled;
    if (!available) {
      return {
        source,
        available: false,
        fixtureSetVersion: null,
        supportedFixtureVersions: [],
        isEmpty: true,
        registers: { RVIE: { periods: [] }, RCE: { periods: [] } },
      };
    }
    const impl = this.sourceFor(source);
    const [rvie, rce] = await Promise.all([
      impl.listPeriods('RVIE'),
      impl.listPeriods('RCE'),
    ]);
    return {
      source,
      available: true,
      fixtureSetVersion: this.fixtureVersionOf(source),
      supportedFixtureVersions:
        source === 'DEMO_FIXTURES' ? supportedFixtureVersions() : [],
      isEmpty: rvie.length === 0 && rce.length === 0,
      registers: { RVIE: { periods: rvie }, RCE: { periods: rce } },
    };
  }
}

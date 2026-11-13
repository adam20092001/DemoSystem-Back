import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { ExcelExportService } from '../common/excel/excel-export.service';
import type { ExcelColumn } from '../common/excel/excel-column';
import { PrismaService } from '../database/prisma.service';
import { normalizeRawDocument } from './core/normalizer';
import { RCE_PERIOD_RULE, RVIE_PERIOD_RULE } from './core/period';
import { computeReconciliation } from './core/reconciliation.engine';
import type {
  ReconciliationItem,
  ReconciliationResult,
} from './core/reconciliation.engine';
import type {
  ProposalRow,
  ReconciliationClassification,
  SireRegister,
  SireSource,
} from './core/types';
import type {
  SireReconciliationExportQueryDto,
  SireReconciliationItemDto,
  SireReconciliationQueryDto,
  SireReconciliationResponseDto,
  SireReconciliationSummaryDto,
} from './dto/sire-demo-reconciliation.dto';
import { getFixtureSet } from './fixtures/fixture-registry';
import {
  SIRE_DEMO_DEFAULT_PAGE_SIZE,
  SIRE_DEMO_DISCLAIMER,
  SIRE_DEMO_FLAGS,
  SIRE_DEMO_FORMAT_VERSION,
  SIRE_DEMO_MODE,
} from './sire-demo.constants';
import type { SireDemoFlags } from './sire-demo.flags';
import { FixtureTaxDocumentSource } from './sources/fixture-tax-document.source';
import { PosTaxDocumentSource } from './sources/pos-tax-document.source';
import type { SourceLoadResult } from './sources/tax-document-source';

const MODULE_NAME = 'SIRE_DEMO';
const ENTITY_TYPE = 'SireDemoProposal';
const DEMO_BANNER = 'DEMO — SIN VALIDEZ ANTE SUNAT';

const SOURCE_NOTE: Record<SireSource, string> = {
  POS: 'Documentos del POS. Los comprobantes electrónicos provienen del proveedor MOCK y NO tienen validez fiscal ante SUNAT; el estado interno nunca implica aceptación.',
  DEMO_FIXTURES:
    'Documentos sintéticos versionados (DEMO_FIXTURES), sin ninguna relación con ventas o compras reales y sin validez fiscal.',
};

export interface ReconciliationActorContext {
  actorUserId: string;
  ipAddress: string | null;
}

/** Resultado único que consumen la API y el Excel (misma lógica, nunca recalculada). */
interface ComputedReconciliation {
  proposal: {
    id: string;
    source: SireSource;
    register: SireRegister;
    period: string;
    fixtureSetVersion: string | null;
    fileName: string;
    fileHash: string;
    rowCount: number;
  };
  loaded: SourceLoadResult;
  result: ReconciliationResult;
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

const money = (value: { toFixed(dp: number): string }): string =>
  value.toFixed(2);

function toItemDto(item: ReconciliationItem): SireReconciliationItemDto {
  return {
    classification: item.classification,
    key: item.key,
    differences: item.differences.map((d) => ({
      field: d.field,
      pos: d.pos,
      proposal: d.proposal,
      delta: d.delta,
    })),
    pos: item.pos
      ? {
          refId: item.pos.refId,
          issueDate: item.pos.issueDate,
          currencyCode: item.pos.currencyCode,
          counterparty: item.pos.counterparty,
          taxableBase:
            item.pos.taxableBase === null ? null : money(item.pos.taxableBase),
          igv: money(item.pos.igv),
          total: money(item.pos.total),
          flags: item.pos.flags,
          internalStatus: item.pos.internalStatus,
        }
      : null,
    proposal: item.proposal
      ? {
          lineNumbers: item.proposal.lineNumbers,
          occurrences: item.proposal.occurrences,
          issueDate: item.proposal.issueDate,
          counterparty: item.proposal.counterparty,
          taxableBase: money(item.proposal.taxableBase),
          igv: money(item.proposal.igv),
          total: money(item.proposal.total),
          duplicateSurplusTotal: money(item.proposal.duplicateSurplusTotal),
        }
      : null,
  };
}

function toSummaryDto(
  summary: ReconciliationResult['summary'],
): SireReconciliationSummaryDto {
  const byClassification =
    {} as SireReconciliationSummaryDto['byClassification'];
  for (const [classification, totals] of Object.entries(
    summary.byClassification,
  ) as [
    ReconciliationClassification,
    ReconciliationResult['summary']['byClassification'][ReconciliationClassification],
  ][]) {
    byClassification[classification] = {
      count: totals.count,
      posTotal: money(totals.posTotal),
      proposalTotal: money(totals.proposalTotal),
    };
  }
  return {
    currencyCode: summary.currencyCode,
    foreignCurrencyDocuments: summary.foreignCurrencyDocuments,
    total: summary.total,
    byClassification,
    totals: {
      pos: money(summary.totals.pos),
      proposalDistinct: money(summary.totals.proposalDistinct),
      duplicateSurplus: money(summary.totals.duplicateSurplus),
      proposalRaw: money(summary.totals.proposalRaw),
      delta: money(summary.totals.delta),
    },
  };
}

/** Columnas del Excel: una fila por ítem del MISMO resultado que devuelve la API. */
interface ExportRow {
  /** null = fila de "SIN RESULTADOS" (filtro sin coincidencias): conserva la identificación DEMO. */
  item: ReconciliationItem | null;
  meta: {
    register: SireRegister;
    period: string;
    source: SireSource;
    fixtureSetVersion: string | null;
    resultDigest: string;
  };
}

const numberOrNull = (value: { toFixed(dp: number): string } | null) =>
  value === null ? null : Number(value.toFixed(2));

const EXPORT_COLUMNS: ExcelColumn<ExportRow>[] = [
  {
    key: 'mode',
    header: 'Modo',
    type: 'string',
    width: 32,
    value: () => DEMO_BANNER,
  },
  {
    key: 'register',
    header: 'Registro',
    type: 'string',
    width: 10,
    value: (r) => r.meta.register,
  },
  {
    key: 'period',
    header: 'Periodo',
    type: 'identifier',
    width: 10,
    value: (r) => r.meta.period,
  },
  {
    key: 'source',
    header: 'Origen',
    type: 'string',
    width: 16,
    value: (r) => r.meta.source,
  },
  {
    key: 'fixtures',
    header: 'Versión de fixtures',
    type: 'string',
    width: 20,
    value: (r) => r.meta.fixtureSetVersion,
  },
  {
    key: 'digest',
    header: 'resultDigest',
    type: 'identifier',
    width: 66,
    value: (r) => r.meta.resultDigest,
  },
  {
    key: 'classification',
    header: 'Clasificación',
    type: 'string',
    width: 24,
    value: (r) => r.item?.classification ?? 'SIN RESULTADOS',
  },
  {
    key: 'docType',
    header: 'Tipo de comprobante',
    type: 'identifier',
    width: 12,
    value: (r) => r.item?.key?.docTypeCode ?? null,
  },
  {
    key: 'series',
    header: 'Serie',
    type: 'identifier',
    width: 10,
    value: (r) => r.item?.key?.series ?? null,
  },
  {
    key: 'number',
    header: 'Número',
    type: 'identifier',
    width: 14,
    value: (r) => r.item?.key?.number ?? null,
  },
  {
    key: 'supplierDoc',
    header: 'Documento del proveedor (RCE)',
    type: 'identifier',
    width: 22,
    value: (r) => r.item?.key?.supplierDocNumber ?? null,
  },
  {
    key: 'posDate',
    header: 'Fecha emisión POS',
    type: 'identifier',
    width: 14,
    value: (r) => r.item?.pos?.issueDate ?? null,
  },
  {
    key: 'propDate',
    header: 'Fecha emisión propuesta',
    type: 'identifier',
    width: 14,
    value: (r) => r.item?.proposal?.issueDate ?? null,
  },
  {
    key: 'posParty',
    header: 'Contraparte POS',
    type: 'string',
    width: 30,
    value: (r) => r.item?.pos?.counterparty.name ?? null,
  },
  {
    key: 'propParty',
    header: 'Contraparte propuesta',
    type: 'string',
    width: 30,
    value: (r) => r.item?.proposal?.counterparty.name ?? null,
  },
  {
    key: 'currency',
    header: 'Moneda POS',
    type: 'string',
    width: 10,
    value: (r) => r.item?.pos?.currencyCode ?? null,
  },
  {
    key: 'posBase',
    header: 'Base POS',
    type: 'number',
    width: 14,
    value: (r) => numberOrNull(r.item?.pos?.taxableBase ?? null),
  },
  {
    key: 'posIgv',
    header: 'IGV POS',
    type: 'number',
    width: 14,
    value: (r) => numberOrNull(r.item?.pos?.igv ?? null),
  },
  {
    key: 'posTotal',
    header: 'Total POS',
    type: 'number',
    width: 14,
    value: (r) => numberOrNull(r.item?.pos?.total ?? null),
  },
  {
    key: 'propBase',
    header: 'Base propuesta',
    type: 'number',
    width: 14,
    value: (r) => numberOrNull(r.item?.proposal?.taxableBase ?? null),
  },
  {
    key: 'propIgv',
    header: 'IGV propuesta',
    type: 'number',
    width: 14,
    value: (r) => numberOrNull(r.item?.proposal?.igv ?? null),
  },
  {
    key: 'propTotal',
    header: 'Total propuesta',
    type: 'number',
    width: 14,
    value: (r) => numberOrNull(r.item?.proposal?.total ?? null),
  },
  {
    key: 'delta',
    header: 'Diferencia de total (propuesta - POS)',
    type: 'number',
    width: 18,
    value: (r) => {
      const d = r.item?.differences.find((x) => x.field === 'total');
      return d?.delta === null || d?.delta === undefined
        ? null
        : Number(d.delta);
    },
  },
  {
    key: 'occurrences',
    header: 'Apariciones en propuesta',
    type: 'number',
    width: 12,
    value: (r) => r.item?.proposal?.occurrences ?? null,
  },
  {
    key: 'surplus',
    header: 'Excedente por duplicado',
    type: 'number',
    width: 14,
    value: (r) => numberOrNull(r.item?.proposal?.duplicateSurplusTotal ?? null),
  },
  {
    key: 'lines',
    header: 'Líneas de la propuesta',
    type: 'string',
    width: 18,
    value: (r) => r.item?.proposal?.lineNumbers.join(', ') ?? null,
  },
  {
    key: 'diffs',
    header: 'Campos con diferencia',
    type: 'string',
    width: 28,
    value: (r) => r.item?.differences.map((d) => d.field).join(', ') || null,
  },
  {
    key: 'flags',
    header: 'Alertas de datos POS',
    type: 'string',
    width: 34,
    value: (r) => r.item?.pos?.flags.join(', ') || null,
  },
];

@Injectable()
export class SireDemoReconciliationService {
  constructor(
    @Inject(SIRE_DEMO_FLAGS) private readonly flags: SireDemoFlags,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly excel: ExcelExportService,
    private readonly posSource: PosTaxDocumentSource,
    private readonly fixtureSource: FixtureTaxDocumentSource,
  ) {}

  async reconcile(
    id: string,
    query: SireReconciliationQueryDto,
  ): Promise<SireReconciliationResponseDto> {
    const computed = await this.compute(id);
    const filtered = this.filter(computed.result, query.classification);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? SIRE_DEMO_DEFAULT_PAGE_SIZE;
    const { proposal, loaded, result } = computed;

    return {
      ...envelope(),
      // Mismos campos de cabecera que las respuestas de S1 (documents).
      source: proposal.source,
      fixtureSetVersion: proposal.fixtureSetVersion,
      register: proposal.register,
      period: proposal.period,
      proposal,
      periodRule:
        proposal.register === 'RVIE' ? RVIE_PERIOD_RULE : RCE_PERIOD_RULE,
      sourceNote: `${SIRE_DEMO_DISCLAIMER} ${SOURCE_NOTE[proposal.source]}`,
      excluded: loaded.excluded,
      counts: result.counts,
      summary: toSummaryDto(result.summary),
      resultDigest: result.resultDigest,
      classification: query.classification ?? null,
      items: filtered
        .slice((page - 1) * pageSize, page * pageSize)
        .map(toItemDto),
      page,
      pageSize,
      totalItems: filtered.length,
    };
  }

  async exportXlsx(
    id: string,
    query: SireReconciliationExportQueryDto,
    ctx: ReconciliationActorContext,
  ): Promise<{ buffer: Buffer; baseFileName: string }> {
    const computed = await this.compute(id);
    const filtered = this.filter(computed.result, query.classification);
    this.excel.assertWithinExportLimit(
      filtered.length,
      'la conciliación SIRE DEMO',
    );
    const { proposal, result } = computed;
    const meta = {
      register: proposal.register,
      period: proposal.period,
      source: proposal.source,
      fixtureSetVersion: proposal.fixtureSetVersion,
      resultDigest: result.resultDigest,
    };
    const buffer = await this.excel.buildWorkbook(
      `SIRE DEMO ${proposal.register} ${proposal.period}`,
      EXPORT_COLUMNS,
      // Con 0 filas se emite UNA fila de "SIN RESULTADOS" para no perder la
      // identificación DEMO / registro / periodo / origen / digest del archivo.
      filtered.length === 0
        ? [{ item: null, meta }]
        : filtered.map((item) => ({ item, meta })),
    );

    await this.audit.record({
      userId: ctx.actorUserId,
      module: MODULE_NAME,
      action: AuditAction.SIRE_DEMO_PROPOSAL_EXPORTED,
      entityType: ENTITY_TYPE,
      entityId: proposal.id,
      description: 'Conciliación SIRE DEMO exportada a Excel',
      metadata: {
        proposalId: proposal.id,
        source: proposal.source,
        register: proposal.register,
        period: proposal.period,
        fixtureSetVersion: proposal.fixtureSetVersion,
        classification: query.classification ?? null,
        rowCount: filtered.length,
        resultDigest: result.resultDigest,
      },
      ipAddress: ctx.ipAddress,
    });

    return {
      buffer,
      // register y period ya están validados (enum / YYYYMM): nombre seguro.
      baseFileName: `sire-demo-${proposal.register.toLowerCase()}-${proposal.period}`,
    };
  }

  private filter(
    result: ReconciliationResult,
    classification: ReconciliationClassification | undefined,
  ): ReconciliationItem[] {
    return classification === undefined
      ? result.items
      : result.items.filter((item) => item.classification === classification);
  }

  /** Única ruta de cálculo: carga propuesta, resuelve el origen correcto y ejecuta el motor de S1. */
  private async compute(id: string): Promise<ComputedReconciliation> {
    const record = await this.prisma.sireDemoProposal.findUnique({
      where: { id },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    });
    if (!record) {
      throw new NotFoundException({
        message: 'Propuesta no encontrada.',
        error: 'Not Found',
        code: 'SIRE_PROPOSAL_NOT_FOUND',
      });
    }
    if (record.status === 'DISCARDED') {
      throw new ConflictException({
        message: 'La propuesta fue descartada y no puede conciliarse.',
        error: 'Conflict',
        code: 'SIRE_PROPOSAL_DISCARDED',
      });
    }

    const register: SireRegister = record.register;
    const source: SireSource = record.source;

    let loaded: SourceLoadResult;
    if (source === 'DEMO_FIXTURES') {
      if (!this.flags.fixturesEnabled) {
        throw new ForbiddenException({
          message:
            'El origen DEMO_FIXTURES no está habilitado en este ambiente.',
          error: 'Forbidden',
          code: 'SIRE_SOURCE_DISABLED',
        });
      }
      // Siempre la versión GUARDADA en la propuesta; nunca la más reciente.
      const version = record.fixtureSetVersion;
      if (version === null || getFixtureSet(version) === undefined) {
        throw new ConflictException({
          message:
            'La versión de fixtures con la que se importó la propuesta ya no está disponible.',
          error: 'Conflict',
          code: 'FIXTURE_SET_UNAVAILABLE',
        });
      }
      loaded = await this.fixtureSource.load(register, record.period, version);
    } else {
      loaded = await this.posSource.load(register, record.period);
    }

    const rows: ProposalRow[] = record.lines.map((line) => ({
      lineNumber: line.lineNumber,
      docTypeCode: line.docTypeCode,
      series: line.series,
      number: line.number,
      issueDate: line.issueDate.toISOString().slice(0, 10),
      cpDocTypeCode: line.cpDocTypeCode,
      cpDocNumber: line.cpDocNumber,
      cpName: line.cpName,
      currencyCode: line.currencyCode,
      taxableBase: line.taxableBase,
      igv: line.igv,
      total: line.total,
    }));

    const result = computeReconciliation(
      register,
      loaded.documents.map(normalizeRawDocument),
      rows,
    );

    return {
      proposal: {
        id: record.id,
        source,
        register,
        period: record.period,
        fixtureSetVersion: record.fixtureSetVersion,
        fileName: record.fileName,
        fileHash: record.fileHash,
        rowCount: record.rowCount,
      },
      loaded,
      result,
    };
  }
}

import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { parseDemoProposal } from './core/demo-proposal.parser';
import type { DemoProposalParseError } from './core/demo-proposal.parser';
import type { SireSource } from './core/types';
import type {
  ListSireProposalsQueryDto,
  SireProposalDto,
  SireProposalListResponseDto,
  SireProposalResponseDto,
  UploadSireProposalDto,
} from './dto/sire-demo-proposal.dto';
import { getFixtureSet } from './fixtures/fixture-registry';
import {
  SIRE_DEMO_DEFAULT_PAGE_SIZE,
  SIRE_DEMO_FLAGS,
  SIRE_DEMO_FORMAT_VERSION,
  SIRE_DEMO_MAX_ACTIVE_PROPOSALS,
  SIRE_DEMO_MAX_FILE_BYTES,
  SIRE_DEMO_MODE,
} from './sire-demo.constants';
import type { SireDemoFlags } from './sire-demo.flags';

const MODULE_NAME = 'SIRE_DEMO';
const ENTITY_TYPE = 'SireDemoProposal';
const LINE_INSERT_CHUNK = 1000;
const TX_TIMEOUT_MS = 30_000;

const PROPOSAL_INCLUDE = {
  createdBy: { select: { id: true, username: true } },
  discardedBy: { select: { id: true, username: true } },
} satisfies Prisma.SireDemoProposalInclude;

type ProposalRecord = Prisma.SireDemoProposalGetPayload<{
  include: typeof PROPOSAL_INCLUDE;
}>;

export interface UploadedProposalFile {
  originalname: string;
  buffer: Buffer;
}

export interface ProposalActorContext {
  actorUserId: string;
  ipAddress: string | null;
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

/** Nombre de archivo seguro para persistir: sin ruta, sin caracteres de control, máx. 255. */
function sanitizeFileName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? '')
    .split('')
    .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim();
  return base.length > 255 ? base.slice(-255) : base;
}

function describeParseError(error: DemoProposalParseError): string {
  const where = error.line > 0 ? `Línea ${error.line}` : 'Archivo';
  return `${where} [${error.field}] ${error.code}: ${error.message}`;
}

@Injectable()
export class SireDemoProposalsService {
  constructor(
    @Inject(SIRE_DEMO_FLAGS) private readonly flags: SireDemoFlags,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Importa un archivo DEMO_V1. Validación completa ANTES de abrir la
   * transacción (todo o nada); persistencia de cabecera + líneas + auditoría
   * en una única transacción serializada por (origen, registro, periodo).
   */
  async upload(
    dto: UploadSireProposalDto,
    file: UploadedProposalFile | undefined,
    ctx: ProposalActorContext,
  ): Promise<{ response: SireProposalResponseDto; created: boolean }> {
    this.assertSourceAvailable(dto.source);

    if (!file || file.buffer.length === 0) {
      throw new BadRequestException({
        message: 'El campo file es obligatorio y no puede estar vacío.',
        error: 'Bad Request',
        code: 'SIRE_FILE_REQUIRED',
      });
    }
    const fileName = sanitizeFileName(file.originalname);
    if (!/\.txt$/i.test(fileName)) {
      throw new BadRequestException({
        message: 'Solo se admiten archivos con extensión .txt.',
        error: 'Bad Request',
        code: 'SIRE_FILE_EXTENSION_INVALID',
      });
    }
    if (file.buffer.length > SIRE_DEMO_MAX_FILE_BYTES) {
      throw new BadRequestException({
        message: `El archivo supera el máximo de ${SIRE_DEMO_MAX_FILE_BYTES} bytes.`,
        error: 'Bad Request',
        code: 'SIRE_FILE_INVALID',
      });
    }

    const parsed = parseDemoProposal(file.buffer, {
      expected: {
        source: dto.source,
        register: dto.register,
        period: dto.period,
      },
    });
    if (!parsed.ok) {
      const messages = parsed.errors.map(describeParseError);
      if (parsed.totalErrors > parsed.errors.length) {
        messages.push(
          `... y ${parsed.totalErrors - parsed.errors.length} error(es) más (total ${parsed.totalErrors}).`,
        );
      }
      throw new BadRequestException({
        message: messages,
        error: 'Bad Request',
        code: 'SIRE_FILE_INVALID',
      });
    }

    const fixtureSetVersion = this.resolveFixtureVersion(
      dto,
      parsed.header.fixtureSetVersion,
    );
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    const lockKey = `sire-demo-proposal:${dto.source}:${dto.register}:${dto.period}`;
    const sizeBytes = file.buffer.length;

    const result = await this.prisma.$transaction(
      async (tx) => {
        // Serializa cargas concurrentes del mismo origen/registro/periodo:
        // idempotencia y límite de activas se evalúan ya con el lock tomado.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS locked`;

        const existing = await tx.sireDemoProposal.findFirst({
          where: {
            source: dto.source,
            register: dto.register,
            period: dto.period,
            fileHash,
            status: 'IMPORTED',
          },
          include: PROPOSAL_INCLUDE,
        });
        if (existing) {
          return { proposal: existing, created: false };
        }

        const active = await tx.sireDemoProposal.count({
          where: {
            source: dto.source,
            register: dto.register,
            period: dto.period,
            status: 'IMPORTED',
          },
        });
        if (active >= SIRE_DEMO_MAX_ACTIVE_PROPOSALS) {
          throw new ConflictException({
            message: `Ya existen ${SIRE_DEMO_MAX_ACTIVE_PROPOSALS} propuestas activas para este origen, registro y periodo. Descarta alguna antes de cargar otra.`,
            error: 'Conflict',
            code: 'SIRE_PROPOSAL_LIMIT_REACHED',
          });
        }

        const created = await tx.sireDemoProposal.create({
          data: {
            source: dto.source,
            register: dto.register,
            period: dto.period,
            fixtureSetVersion,
            fileName,
            fileSizeBytes: sizeBytes,
            fileHash,
            rowCount: parsed.rows.length,
            createdByUserId: ctx.actorUserId,
          },
        });

        for (let i = 0; i < parsed.rows.length; i += LINE_INSERT_CHUNK) {
          await tx.sireDemoProposalLine.createMany({
            data: parsed.rows.slice(i, i + LINE_INSERT_CHUNK).map((row) => ({
              proposalId: created.id,
              lineNumber: row.lineNumber,
              docTypeCode: row.docTypeCode,
              series: row.series,
              number: row.number,
              issueDate: new Date(`${row.issueDate}T00:00:00.000Z`),
              cpDocTypeCode: row.cpDocTypeCode,
              cpDocNumber: row.cpDocNumber,
              cpName: row.cpName,
              currencyCode: row.currencyCode,
              taxableBase: row.taxableBase,
              igv: row.igv,
              total: row.total,
            })),
          });
        }

        await this.audit.record({
          userId: ctx.actorUserId,
          module: MODULE_NAME,
          action: AuditAction.SIRE_DEMO_PROPOSAL_IMPORTED,
          entityType: ENTITY_TYPE,
          entityId: created.id,
          description: 'Propuesta SIRE DEMO importada',
          metadata: {
            proposalId: created.id,
            source: dto.source,
            register: dto.register,
            period: dto.period,
            fixtureSetVersion,
            rowCount: parsed.rows.length,
            fileSizeBytes: sizeBytes,
          },
          ipAddress: ctx.ipAddress,
          client: tx,
        });

        const full = await tx.sireDemoProposal.findUniqueOrThrow({
          where: { id: created.id },
          include: PROPOSAL_INCLUDE,
        });
        return { proposal: full, created: true };
      },
      { timeout: TX_TIMEOUT_MS },
    );

    return {
      created: result.created,
      response: {
        ...envelope(),
        reused: !result.created,
        proposal: this.toDto(result.proposal),
      },
    };
  }

  async list(
    query: ListSireProposalsQueryDto,
  ): Promise<SireProposalListResponseDto> {
    if (query.source === 'DEMO_FIXTURES') {
      this.assertSourceAvailable('DEMO_FIXTURES');
    }
    const where: Prisma.SireDemoProposalWhereInput = {
      ...(query.source ? { source: query.source } : {}),
      ...(query.register ? { register: query.register } : {}),
      ...(query.period ? { period: query.period } : {}),
      ...(query.status ? { status: query.status } : {}),
      // Origen no disponible: sus propuestas no se listan.
      ...(!query.source && !this.flags.fixturesEnabled
        ? { source: 'POS' as const }
        : {}),
    };
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? SIRE_DEMO_DEFAULT_PAGE_SIZE;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.sireDemoProposal.count({ where }),
      this.prisma.sireDemoProposal.findMany({
        where,
        include: PROPOSAL_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      ...envelope(),
      items: rows.map((row) => this.toDto(row)),
      page,
      pageSize,
      totalItems: total,
    };
  }

  /** Descarte lógico: conserva cabecera y líneas. Un segundo descarte responde 409. */
  async discard(
    id: string,
    ctx: ProposalActorContext,
  ): Promise<SireProposalResponseDto> {
    const proposal = await this.prisma.$transaction(async (tx) => {
      const current = await tx.sireDemoProposal.findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException({
          message: 'Propuesta no encontrada.',
          error: 'Not Found',
          code: 'SIRE_PROPOSAL_NOT_FOUND',
        });
      }
      this.assertSourceAvailable(current.source);

      // Atómico: solo una de dos solicitudes concurrentes cambia la fila.
      const updated = await tx.sireDemoProposal.updateMany({
        where: { id, status: 'IMPORTED' },
        data: {
          status: 'DISCARDED',
          discardedAt: new Date(),
          discardedByUserId: ctx.actorUserId,
        },
      });
      if (updated.count === 0) {
        throw new ConflictException({
          message: 'La propuesta ya fue descartada.',
          error: 'Conflict',
          code: 'SIRE_PROPOSAL_ALREADY_DISCARDED',
        });
      }

      await this.audit.record({
        userId: ctx.actorUserId,
        module: MODULE_NAME,
        action: AuditAction.SIRE_DEMO_PROPOSAL_DISCARDED,
        entityType: ENTITY_TYPE,
        entityId: id,
        description: 'Propuesta SIRE DEMO descartada',
        metadata: {
          proposalId: id,
          source: current.source,
          register: current.register,
          period: current.period,
        },
        ipAddress: ctx.ipAddress,
        client: tx,
      });

      return tx.sireDemoProposal.findUniqueOrThrow({
        where: { id },
        include: PROPOSAL_INCLUDE,
      });
    });

    return { ...envelope(), reused: false, proposal: this.toDto(proposal) };
  }

  private assertSourceAvailable(source: SireSource): void {
    if (source === 'DEMO_FIXTURES' && !this.flags.fixturesEnabled) {
      throw new ForbiddenException({
        message: 'El origen DEMO_FIXTURES no está habilitado en este ambiente.',
        error: 'Forbidden',
        code: 'SIRE_SOURCE_DISABLED',
      });
    }
  }

  /**
   * DEMO_FIXTURES: la versión de la cabecera debe existir y el periodo debe
   * pertenecer a ese conjunto; nunca se sustituye por otra versión. POS: null.
   */
  private resolveFixtureVersion(
    dto: UploadSireProposalDto,
    headerVersion: string | null,
  ): string | null {
    if (dto.source !== 'DEMO_FIXTURES') {
      return null;
    }
    const set =
      headerVersion === null ? undefined : getFixtureSet(headerVersion);
    if (!set) {
      throw new BadRequestException({
        message: 'La versión de fixtures de la cabecera no existe.',
        error: 'Bad Request',
        code: 'FIXTURE_VERSION_UNKNOWN',
      });
    }
    if (!set.periods[dto.register].includes(dto.period)) {
      throw new BadRequestException({
        message: `El conjunto de fixtures ${set.version} no incluye el periodo ${dto.period} para ${dto.register}.`,
        error: 'Bad Request',
        code: 'FIXTURE_PERIOD_UNAVAILABLE',
      });
    }
    return set.version;
  }

  private toDto(row: ProposalRecord): SireProposalDto {
    const available = row.source === 'POS' || this.flags.fixturesEnabled;
    return {
      id: row.id,
      source: row.source,
      register: row.register,
      period: row.period,
      fixtureSetVersion: row.fixtureSetVersion,
      fileName: row.fileName,
      fileSizeBytes: row.fileSizeBytes,
      fileHash: row.fileHash,
      rowCount: row.rowCount,
      status: row.status,
      reconcilable: row.status === 'IMPORTED' && available,
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy,
      discardedAt: row.discardedAt ? row.discardedAt.toISOString() : null,
      discardedBy: row.discardedBy,
    };
  }
}

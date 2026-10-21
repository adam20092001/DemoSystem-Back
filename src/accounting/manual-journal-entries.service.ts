import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountingSourceType,
  ManualJournalDraftStatus,
  Prisma,
  RoleName,
} from '@prisma/client';
import { AccountingEngine } from './accounting.engine';
import {
  assertManualDraftLinesBalanced,
  parseManualDraftLineAmounts,
} from './manual-journal-entries.utils';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import {
  fromPrismaDate,
  isValidDateOnly,
  toPrismaDate,
} from '../common/date/business-date';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import {
  MANUAL_JOURNAL_DRAFT_SAFE_SELECT,
  toSafeManualJournalDraft,
} from './mappers/manual-journal-entry.mapper';
import {
  CreateManualJournalDraftInput,
  ListManualJournalDraftsQuery,
  PostManualJournalDraftInput,
  ReverseManualJournalEntryInput,
  SafeManualJournalDraft,
  UpdateManualJournalDraftInput,
} from './types/manual-journal-entry';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const AUDIT_MODULE = 'ACCOUNTING';
const AUDIT_ENTITY_TYPE = 'ManualJournalDraft';

/**
 * Alcance de lectura (Fase A4.1): ADMIN/ACCOUNTANT/MANAGEMENT — mismo
 * criterio que el resto del dominio contable (chart-of-accounts/periods/
 * reports). SELLER/WAREHOUSE sin ningún acceso.
 */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
]);

/**
 * Alcance de administración (crear/editar/contabilizar/revertir, A4.1):
 * SOLO ADMIN/ACCOUNTANT — MANAGEMENT nunca adquiere escritura aquí (mismo
 * criterio ya cerrado para el resto del dominio contable, P6-E4).
 */
const MANAGE_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.ACCOUNTANT,
]);

function assertCanReadDrafts(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar los asientos manuales',
    );
  }
}

function assertCanManageDrafts(requesterRole: RoleName): void {
  if (!MANAGE_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para administrar asientos manuales',
    );
  }
}

function normalizeDescription(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BadRequestException('description no puede estar en blanco');
  }
  if (trimmed.length > 200) {
    throw new BadRequestException(
      'description no puede superar los 200 caracteres',
    );
  }
  return trimmed;
}

function normalizeAccountingDateOnly(value: string): Date {
  if (!isValidDateOnly(value)) {
    throw new BadRequestException(
      `accountingDate debe ser una fecha real en formato YYYY-MM-DD: "${value}"`,
    );
  }
  return toPrismaDate(value);
}

interface LockedDraftRow {
  id: string;
  status: ManualJournalDraftStatus;
  postedEntryId: string | null;
}

/**
 * Ciclo de vida completo de borradores de asiento manual (Fase A4):
 * crear/editar/listar/consultar (este servicio), contabilizar y revertir
 * (delegando el posteo/reversión REAL siempre a AccountingEngine, que
 * sigue siendo el único escritor de AccountingEntry/AccountingEntryLine —
 * este servicio NUNCA escribe esas tablas directamente). Los borradores
 * viven en su propio modelo (ManualJournalDraft/ManualJournalDraftLine),
 * nunca como filas de AccountingEntry — así los reportes de A3 jamás
 * incluyen un monto todavía no contabilizado (A4.2).
 */
@Injectable()
export class ManualJournalEntriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly accountingEngine: AccountingEngine,
  ) {}

  // ==================================================================
  // Lectura
  // ==================================================================

  async listDrafts(
    query: ListManualJournalDraftsQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeManualJournalDraft>> {
    assertCanReadDrafts(requesterRole);

    const page =
      query.page !== undefined && query.page > 0
        ? Math.floor(query.page)
        : DEFAULT_PAGE;
    const limit = Math.min(
      query.limit !== undefined && query.limit > 0
        ? Math.floor(query.limit)
        : DEFAULT_LIMIT,
      MAX_LIMIT,
    );
    const skip = (page - 1) * limit;

    const where: Prisma.ManualJournalDraftWhereInput = {};
    if (query.status !== undefined) {
      where.status = query.status;
    }

    const [rows, total] = await Promise.all([
      this.prisma.manualJournalDraft.findMany({
        where,
        select: MANUAL_JOURNAL_DRAFT_SAFE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.manualJournalDraft.count({ where }),
    ]);

    return {
      data: rows.map(toSafeManualJournalDraft),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findDraftById(
    id: string,
    requesterRole: RoleName,
  ): Promise<SafeManualJournalDraft> {
    assertCanReadDrafts(requesterRole);

    const row = await this.prisma.manualJournalDraft.findUnique({
      where: { id },
      select: MANUAL_JOURNAL_DRAFT_SAFE_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('Borrador de asiento manual no encontrado');
    }
    return toSafeManualJournalDraft(row);
  }

  // ==================================================================
  // Escritura — borrador (A4.2)
  // ==================================================================

  async createDraft(
    input: CreateManualJournalDraftInput,
  ): Promise<SafeManualJournalDraft> {
    assertCanManageDrafts(input.requesterRole);

    const accountingDate = normalizeAccountingDateOnly(input.accountingDate);
    const description = normalizeDescription(input.description);
    const lines = input.lines ?? [];

    return this.prisma.$transaction(async (tx) => {
      await this.assertAccountsExist(
        tx,
        lines.map((line) => line.accountId),
      );
      const parsedLines = lines.map((line) => ({
        accountId: line.accountId,
        ...parseManualDraftLineAmounts(line),
      }));

      const created = await tx.manualJournalDraft.create({
        data: {
          accountingDate,
          description,
          createdByUserId: input.actorUserId,
          lines: {
            create: parsedLines.map((line) => ({
              accountId: line.accountId,
              debitAmount: line.debitAmount,
              creditAmount: line.creditAmount,
            })),
          },
        },
        select: MANUAL_JOURNAL_DRAFT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: AuditAction.MANUAL_JOURNAL_DRAFT_CREATED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: created.id,
        description: `Borrador de asiento manual creado: ${description}`,
        metadata: {
          draftId: created.id,
          accountingDate: fromPrismaDate(created.accountingDate),
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeManualJournalDraft(created);
    });
  }

  /**
   * PATCH con reemplazo COMPLETO de `lines` cuando se provee (A4.2: "the
   * smallest suitable schema model" — nunca un parche línea a línea, que
   * exigiría un identificador estable por línea en el request). Bloqueado
   * por fila (A4.6, requisito #2: "a posting request cannot race with
   * draft editing") — la misma fila que `postDraft()`/`reverseEntry()`
   * bloquean, así que edición y contabilización de UN MISMO borrador
   * nunca se intercalan de forma inconsistente.
   */
  async updateDraft(
    input: UpdateManualJournalDraftInput,
  ): Promise<SafeManualJournalDraft> {
    assertCanManageDrafts(input.requesterRole);

    const hasAnyField =
      input.accountingDate !== undefined ||
      input.description !== undefined ||
      input.lines !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar: accountingDate, description o lines',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockDraft(tx, input.draftId);
      if (locked.status !== ManualJournalDraftStatus.DRAFT) {
        throw new ConflictException(
          'Solo se puede editar un borrador mientras está en estado DRAFT',
        );
      }

      const data: Prisma.ManualJournalDraftUpdateInput = {};
      const changedFields: string[] = [];

      if (input.accountingDate !== undefined) {
        data.accountingDate = normalizeAccountingDateOnly(input.accountingDate);
        changedFields.push('accountingDate');
      }
      if (input.description !== undefined) {
        data.description = normalizeDescription(input.description);
        changedFields.push('description');
      }
      if (input.lines !== undefined) {
        await this.assertAccountsExist(
          tx,
          input.lines.map((line) => line.accountId),
        );
        const parsedLines = input.lines.map((line) => ({
          accountId: line.accountId,
          ...parseManualDraftLineAmounts(line),
        }));
        // Reemplazo completo: el id del borrador es un valor real
        // garantizado (nunca undefined) por LockedDraftRow ya resuelto
        // arriba — deleteMany() siempre queda acotado a este borrador.
        await tx.manualJournalDraftLine.deleteMany({
          where: { draftId: locked.id },
        });
        await tx.manualJournalDraftLine.createMany({
          data: parsedLines.map((line) => ({
            draftId: locked.id,
            accountId: line.accountId,
            debitAmount: line.debitAmount,
            creditAmount: line.creditAmount,
          })),
        });
        changedFields.push('lines');
      }

      if (Object.keys(data).length > 0) {
        await tx.manualJournalDraft.update({
          where: { id: locked.id },
          data,
        });
      }

      const updated = await tx.manualJournalDraft.findUniqueOrThrow({
        where: { id: locked.id },
        select: MANUAL_JOURNAL_DRAFT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: AuditAction.MANUAL_JOURNAL_DRAFT_UPDATED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: locked.id,
        description: 'Borrador de asiento manual actualizado',
        metadata: { draftId: locked.id, changedFields },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeManualJournalDraft(updated);
    });
  }

  // ==================================================================
  // Contabilización (A4.3/A4.4)
  // ==================================================================

  /**
   * Contabiliza DEFINITIVAMENTE un borrador (A4.4). El lock de fila
   * (`SELECT ... FOR UPDATE` sobre el borrador, vía lockDraft()) resuelve
   * por sí solo, sin ningún lock global adicional, los requisitos de
   * concurrencia A4.6 #1 ("two simultaneous requests cannot post the same
   * draft twice") y #7 ("a repeated HTTP request does not create a second
   * journal"): la segunda petición concurrente espera a que la primera
   * confirme, y entonces ve `status=POSTED` y se rechaza con 409 — nunca
   * un segundo AccountingEntry. El índice único parcial
   * accounting_entries_one_original_per_source (A1/A2, sin cambios) es
   * además una segunda línea de defensa totalmente independiente a nivel
   * de base de datos, por si alguna vía evadiera el lock.
   */
  async postDraft(
    input: PostManualJournalDraftInput,
  ): Promise<SafeManualJournalDraft> {
    assertCanManageDrafts(input.requesterRole);

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockDraft(tx, input.draftId);
      if (locked.status === ManualJournalDraftStatus.POSTED) {
        throw new ConflictException('Este borrador ya fue contabilizado');
      }

      const draft = await tx.manualJournalDraft.findUniqueOrThrow({
        where: { id: locked.id },
        include: { lines: true },
      });

      if (draft.lines.length < 2) {
        throw new BadRequestException(
          'El borrador debe tener al menos dos líneas antes de contabilizarse',
        );
      }
      for (const line of draft.lines) {
        if (line.debitAmount.isZero() && line.creditAmount.isZero()) {
          throw new BadRequestException(
            'Ninguna línea puede tener debitAmount y creditAmount en cero al contabilizar',
          );
        }
      }
      assertManualDraftLinesBalanced(draft.lines);

      const accountingDateOnly = fromPrismaDate(draft.accountingDate);

      const posted = await this.accountingEngine.postManualEntry(tx, {
        draftId: draft.id,
        description: draft.description,
        accountingDateOnly,
        lines: draft.lines.map((line) => ({
          accountId: line.accountId,
          debitAmount: line.debitAmount,
          creditAmount: line.creditAmount,
        })),
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress,
      });

      const updated = await tx.manualJournalDraft.update({
        where: { id: draft.id },
        data: {
          status: ManualJournalDraftStatus.POSTED,
          postedEntryId: posted.id,
        },
        select: MANUAL_JOURNAL_DRAFT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: AuditAction.MANUAL_JOURNAL_POSTED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: draft.id,
        description: `Borrador de asiento manual contabilizado: ${draft.description}`,
        metadata: {
          draftId: draft.id,
          entryId: posted.id,
          accountingDate: accountingDateOnly,
          journalNumber: posted.journalNumber,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeManualJournalDraft(updated);
    });
  }

  // ==================================================================
  // Reversión (A4.5)
  // ==================================================================

  /**
   * Revierte el AccountingEntry definitivo de un borrador ya contabilizado
   * (A4.5). `sourceType: MANUAL` + `sourceId: draftId` hacen
   * estructuralmente imposible revertir por accidente un asiento SALE/
   * PAYMENT a través de esta vía — AccountingEngine.reverseOriginalForSource()
   * busca exclusivamente por ese par exacto. La doble reversión ya la
   * impide reverseOriginalForSource() por sí solo (su propio chequeo de
   * `existingReversal`, sin código nuevo aquí).
   */
  async reverseEntry(
    input: ReverseManualJournalEntryInput,
  ): Promise<SafeManualJournalDraft> {
    assertCanManageDrafts(input.requesterRole);

    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new BadRequestException('reason es obligatorio');
    }
    if (reason.length > 200) {
      throw new BadRequestException(
        'reason no puede superar los 200 caracteres',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockDraft(tx, input.draftId);
      if (
        locked.status !== ManualJournalDraftStatus.POSTED ||
        locked.postedEntryId === null
      ) {
        throw new ConflictException(
          'Solo se puede revertir un borrador ya contabilizado',
        );
      }

      const reversal = await this.accountingEngine.reverseOriginalForSource(
        tx,
        {
          sourceType: AccountingSourceType.MANUAL,
          sourceId: locked.id,
          // No aplica para MANUAL: el motor reutiliza la descripción del
          // propio ORIGINAL ya cargado internamente, nunca este valor.
          sourceNumber: '',
          postedAt: new Date(),
          actorUserId: input.actorUserId,
          ipAddress: input.ipAddress,
        },
      );

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: AuditAction.MANUAL_JOURNAL_REVERSED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: locked.id,
        description: `Reversión de asiento manual contabilizado (borrador ${locked.id})`,
        metadata: {
          draftId: locked.id,
          entryId: locked.postedEntryId,
          reversalEntryId: reversal.id,
          reason,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      const updated = await tx.manualJournalDraft.findUniqueOrThrow({
        where: { id: locked.id },
        select: MANUAL_JOURNAL_DRAFT_SAFE_SELECT,
      });
      return toSafeManualJournalDraft(updated);
    });
  }

  // ==================================================================
  // Helpers privados
  // ==================================================================

  /**
   * Único punto de lock de fila sobre un borrador (A4.6): usado por
   * updateDraft()/postDraft()/reverseEntry() — las tres mutaciones
   * posibles sobre un mismo borrador se serializan entre sí sin ningún
   * lock global, mismo patrón ya establecido por PaymentEngine.cancel().
   */
  private async lockDraft(
    tx: Prisma.TransactionClient,
    draftId: string,
  ): Promise<LockedDraftRow> {
    const rows = await tx.$queryRaw<LockedDraftRow[]>(Prisma.sql`
      SELECT id, status, posted_entry_id AS "postedEntryId"
      FROM manual_journal_drafts
      WHERE id = ${draftId}::uuid
      FOR UPDATE
    `);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('Borrador de asiento manual no encontrado');
    }
    return row;
  }

  /**
   * Validación de EXISTENCIA pura (A4.2): cualquier cuenta real, activa o
   * no, postable o no — la validación ESTRICTA (ACTIVE + isPostable) es
   * exclusiva del momento de contabilizar (A4.3), dentro de
   * AccountingEngine.postManualEntry(), nunca mientras se edita un
   * borrador todavía incompleto.
   */
  private async assertAccountsExist(
    tx: Prisma.TransactionClient,
    accountIds: string[],
  ): Promise<void> {
    const uniqueIds = Array.from(new Set(accountIds));
    if (uniqueIds.length === 0) {
      return;
    }
    const count = await tx.account.count({
      where: { id: { in: uniqueIds } },
    });
    if (count !== uniqueIds.length) {
      throw new BadRequestException(
        'Una o más cuentas especificadas no existen',
      );
    }
  }
}

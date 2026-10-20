import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountStatus, Prisma, RoleName } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import {
  ROOT_ACCOUNT_LEVEL,
  computeChildLevel,
} from './account-hierarchy.utils';
import {
  buildAccountTree,
  CHART_ACCOUNT_SAFE_SELECT,
  toSafeChartAccount,
} from './mappers/chart-of-account.mapper';
import { AccountStatusActionInput } from './types/account-status-action.input';
import { AccountTreeNode } from './types/account-tree-node';
import { CreateAccountInput } from './types/create-account.input';
import { ListChartAccountsQuery } from './types/list-chart-accounts.query';
import { ReassignSystemKeyInput } from './types/reassign-system-key.input';
import { SafeChartAccount } from './types/safe-chart-account';
import { UpdateAccountInput } from './types/update-account.input';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Mismo tope defensivo que CategoriesService contra jerarquías corruptas o anormalmente profundas. */
const MAX_ANCESTOR_DEPTH = 100;

const AUDIT_MODULE = 'ACCOUNTING';
const AUDIT_ENTITY_TYPE = 'Account';

/**
 * Mismo criterio de alcance que AccountingService (hasAccountingReadAccess):
 * ni SELLER ni WAREHOUSE tienen ningún acceso al plan de cuentas — es el
 * libro contable interno, no una pantalla operativa de ventas (A1.5,
 * kickoff aprobado: "SELLER and WAREHOUSE: no additional accounting
 * permissions").
 */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
]);

function assertCanReadChartOfAccounts(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar el plan de cuentas',
    );
  }
}

/**
 * Único rol autorizado a escribir (A1.5: "ADMIN: manage the chart of
 * accounts and mappings"). MANAGEMENT nunca adquiere escritura aquí,
 * mismo criterio ya cerrado para el resto del dominio contable (P6-E4).
 */
function assertCanMutateChartOfAccounts(requesterRole: RoleName): void {
  if (requesterRole !== RoleName.ADMIN) {
    throw new ForbiddenException(
      'No tiene permisos para administrar el plan de cuentas',
    );
  }
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BadRequestException('name no puede estar en blanco');
  }
  return trimmed;
}

/**
 * Administración del plan de cuentas jerárquico PCGE (Fase A1). Reutiliza
 * exactamente el patrón ya probado de CategoriesService para la jerarquía
 * (parentId/assertParentUsable/assertNoCycle) y de PaymentMethodsService
 * para el PATCH con semántica de no-op real. NUNCA escribe
 * AccountingEntry/AccountingEntryLine ni invoca a AccountingEngine: este
 * servicio administra el CATÁLOGO de cuentas, no los asientos — mismo
 * límite que ya respeta AccountingService (solo lectura de asientos).
 * `AccountingEngine.resolveAccounts()` sigue siendo el único lector de
 * `Account.systemKey` para decidir dónde postear, sin cambios en esta
 * fase.
 */
@Injectable()
export class ChartOfAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  // ==================================================================
  // Lectura
  // ==================================================================

  async listAccounts(
    query: ListChartAccountsQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeChartAccount>> {
    assertCanReadChartOfAccounts(requesterRole);

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

    const where: Prisma.AccountWhereInput = {};
    if (query.type !== undefined) {
      where.type = query.type;
    }
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.isPostable !== undefined) {
      where.isPostable = query.isPostable;
    }
    if (query.parentId !== undefined) {
      where.parentId = query.parentId;
    }
    const term = query.search?.trim();
    if (term !== undefined && term.length > 0) {
      where.OR = [
        { code: { contains: term, mode: 'insensitive' } },
        { name: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.account.findMany({
        where,
        select: CHART_ACCOUNT_SAFE_SELECT,
        orderBy: [{ code: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.account.count({ where }),
    ]);

    return {
      data: rows.map(toSafeChartAccount),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /**
   * Árbol completo en una sola consulta (sin paginar: ver docblock de
   * buildAccountTree — un plan de cuentas completo sigue siendo trivial
   * de cargar en memoria).
   */
  async getAccountTree(requesterRole: RoleName): Promise<AccountTreeNode[]> {
    assertCanReadChartOfAccounts(requesterRole);

    const rows = await this.prisma.account.findMany({
      select: CHART_ACCOUNT_SAFE_SELECT,
      orderBy: [{ code: 'asc' }],
    });
    return buildAccountTree(rows.map(toSafeChartAccount));
  }

  async findAccountById(
    id: string,
    requesterRole: RoleName,
  ): Promise<SafeChartAccount> {
    assertCanReadChartOfAccounts(requesterRole);

    const row = await this.prisma.account.findUnique({
      where: { id },
      select: CHART_ACCOUNT_SAFE_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('Cuenta no encontrada');
    }
    return toSafeChartAccount(row);
  }

  // ==================================================================
  // Escritura
  // ==================================================================

  async createAccount(input: CreateAccountInput): Promise<SafeChartAccount> {
    assertCanMutateChartOfAccounts(input.requesterRole);

    const code = normalizeCode(input.code);
    const name = normalizeName(input.name);
    const isPostable = input.isPostable ?? true;

    return this.prisma.$transaction(async (tx) => {
      const existingCode = await tx.account.findUnique({
        where: { code },
        select: { id: true },
      });
      if (existingCode !== null) {
        throw new ConflictException(`Ya existe una cuenta con code "${code}"`);
      }

      let level = ROOT_ACCOUNT_LEVEL;
      if (input.parentId !== undefined) {
        const parent = await this.assertParentUsableForNewChild(
          tx,
          input.parentId,
        );
        level = computeChildLevel(parent.level);
      }

      const created = await tx.account.create({
        data: {
          code,
          name,
          type: input.type,
          parentId: input.parentId ?? null,
          level,
          isPostable,
          status: AccountStatus.ACTIVE,
        },
        select: CHART_ACCOUNT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: AuditAction.ACCOUNT_CREATED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: created.id,
        description: `Cuenta ${code} creada`,
        metadata: {
          code,
          name,
          type: input.type,
          ...(created.parentId !== null ? { parentId: created.parentId } : {}),
          level,
          isPostable,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeChartAccount(created);
    });
  }

  /**
   * PATCH con semántica de no-op real (mismo criterio que
   * ConfigurationService/PaymentMethodsService): un campo solo se marca
   * "cambiado" si su valor normalizado difiere del vigente.
   */
  async updateAccount(input: UpdateAccountInput): Promise<SafeChartAccount> {
    assertCanMutateChartOfAccounts(input.requesterRole);

    const hasAnyField =
      input.name !== undefined ||
      input.parentId !== undefined ||
      input.type !== undefined ||
      input.isPostable !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar: name, parentId, type o isPostable',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.account.findUnique({
        where: { id: input.accountId },
        select: CHART_ACCOUNT_SAFE_SELECT,
      });
      if (existing === null) {
        throw new NotFoundException('Cuenta no encontrada');
      }

      const data: Prisma.AccountUpdateInput = {};
      const changedFields: string[] = [];
      const oldValues: Record<string, string | number | boolean | null> = {};
      const newValues: Record<string, string | number | boolean | null> = {};

      function markChanged(
        field: string,
        oldValue: string | number | boolean | null,
        newValue: string | number | boolean | null,
      ): void {
        changedFields.push(field);
        oldValues[field] = oldValue;
        newValues[field] = newValue;
      }

      if (input.name !== undefined) {
        const name = normalizeName(input.name);
        if (name !== existing.name) {
          data.name = name;
          markChanged('name', existing.name, name);
        }
      }

      let newLevel: number | undefined;
      if (input.parentId !== undefined) {
        if (input.parentId === null) {
          if (existing.parentId !== null) {
            data.parent = { disconnect: true };
            newLevel = ROOT_ACCOUNT_LEVEL;
            markChanged('parentId', existing.parentId, null);
          }
        } else {
          if (input.parentId === input.accountId) {
            throw new BadRequestException(
              'Una cuenta no puede ser su propio padre',
            );
          }
          if (input.parentId !== existing.parentId) {
            const parent = await this.assertParentUsableForNewChild(
              tx,
              input.parentId,
            );
            await this.assertNoCycle(tx, input.accountId, input.parentId);
            newLevel = computeChildLevel(parent.level);
            data.parent = { connect: { id: input.parentId } };
            markChanged('parentId', existing.parentId, input.parentId);
          }
        }
      }
      if (newLevel !== undefined && newLevel !== existing.level) {
        data.level = newLevel;
        markChanged('level', existing.level, newLevel);
      }

      if (input.type !== undefined && input.type !== existing.type) {
        await this.assertTypeChangeAllowed(tx, input.accountId);
        data.type = input.type;
        markChanged('type', existing.type, input.type);
      }

      if (
        input.isPostable !== undefined &&
        input.isPostable !== existing.isPostable
      ) {
        if (input.isPostable) {
          await this.assertCanBecomePostable(tx, input.accountId);
        } else if (existing.systemKey !== null) {
          // A1-review: una cuenta de sistema (systemKey no nulo) nunca
          // puede volverse no-postable — AccountingEngine.resolveAccounts()
          // la sigue necesitando para resolver asientos nuevos de ese
          // systemKey, y ya filtra explícitamente por isPostable=true
          // (defensa en profundidad del motor); esta validación evita
          // directamente llegar a ese estado inconsistente, con el mismo
          // criterio exacto que ya protege la desactivación
          // (deactivateAccount()).
          throw new ConflictException(
            `No se puede marcar como no postable: es una cuenta de sistema requerida por AccountingEngine (${existing.systemKey})`,
          );
        }
        data.isPostable = input.isPostable;
        markChanged('isPostable', existing.isPostable, input.isPostable);
      }

      if (changedFields.length === 0) {
        return toSafeChartAccount(existing);
      }

      const updated = await tx.account.update({
        where: { id: input.accountId },
        data,
        select: CHART_ACCOUNT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: AuditAction.ACCOUNT_UPDATED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: input.accountId,
        description: `Cuenta ${existing.code} actualizada`,
        metadata: { code: existing.code, changedFields, oldValues, newValues },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeChartAccount(updated);
    });
  }

  async activateAccount(
    input: AccountStatusActionInput,
  ): Promise<SafeChartAccount> {
    assertCanMutateChartOfAccounts(input.requesterRole);

    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findUnique({
        where: { id: input.accountId },
        select: CHART_ACCOUNT_SAFE_SELECT,
      });
      if (account === null) {
        throw new NotFoundException('Cuenta no encontrada');
      }
      if (account.status === AccountStatus.ACTIVE) {
        throw new ConflictException('La cuenta ya está activa');
      }

      if (account.parentId !== null) {
        const parent = await tx.account.findUnique({
          where: { id: account.parentId },
          select: { status: true },
        });
        if (parent === null || parent.status !== AccountStatus.ACTIVE) {
          throw new ConflictException(
            'No es posible activar: la cuenta padre no está activa',
          );
        }
      }

      const activated = await tx.account.update({
        where: { id: input.accountId },
        data: { status: AccountStatus.ACTIVE },
        select: CHART_ACCOUNT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: AuditAction.ACCOUNT_ACTIVATED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: input.accountId,
        description: `Cuenta ${account.code} activada`,
        metadata: { code: account.code },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeChartAccount(activated);
    });
  }

  /**
   * Protección de cuentas de sistema (A1.2: "Protect system-required
   * accounts from unsafe deactivation"): una cuenta con systemKey nunca
   * se puede desactivar — AccountingEngine la sigue necesitando para
   * resolver asientos nuevos. Desactivar nunca borra ni reescribe ningún
   * AccountingEntryLine histórico (mismo criterio que PaymentMethod).
   */
  async deactivateAccount(
    input: AccountStatusActionInput,
  ): Promise<SafeChartAccount> {
    assertCanMutateChartOfAccounts(input.requesterRole);

    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findUnique({
        where: { id: input.accountId },
        select: CHART_ACCOUNT_SAFE_SELECT,
      });
      if (account === null) {
        throw new NotFoundException('Cuenta no encontrada');
      }
      if (account.status === AccountStatus.INACTIVE) {
        throw new ConflictException('La cuenta ya está inactiva');
      }
      if (account.systemKey !== null) {
        throw new ConflictException(
          `No es posible desactivar: es una cuenta de sistema requerida por AccountingEngine (${account.systemKey})`,
        );
      }

      const activeChildren = await tx.account.count({
        where: { parentId: input.accountId, status: AccountStatus.ACTIVE },
      });
      if (activeChildren > 0) {
        throw new ConflictException(
          'No es posible desactivar: existen subcuentas activas',
        );
      }

      const deactivated = await tx.account.update({
        where: { id: input.accountId },
        data: { status: AccountStatus.INACTIVE },
        select: CHART_ACCOUNT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: AuditAction.ACCOUNT_DEACTIVATED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: input.accountId,
        description: `Cuenta ${account.code} desactivada`,
        metadata: { code: account.code },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeChartAccount(deactivated);
    });
  }

  /**
   * A1.3 — capacidad TÉCNICA de reasignación de mapeo (nunca ejercida
   * automáticamente por A1: ninguna llamada a este método existe en
   * seed.ts ni en ningún otro flujo de esta fase — ver CRITICAL MIGRATION
   * AND ACTIVATION RULE del kickoff). Mueve `systemKey` de quien lo
   * sostiene hoy hacia `targetAccountId`, dentro de una única
   * transacción. `AccountingEngine.resolveAccounts()` sigue sin cambios:
   * sigue resolviendo por `Account.systemKey` tal cual, así que el
   * siguiente asiento que postee ese systemKey usará automáticamente la
   * cuenta nueva, sin tocar ningún AccountingEntryLine ya existente (esos
   * siguen apuntando por accountId a la cuenta que tenían en el momento
   * de postearse, para siempre).
   */
  async reassignSystemKey(
    input: ReassignSystemKeyInput,
  ): Promise<SafeChartAccount> {
    assertCanMutateChartOfAccounts(input.requesterRole);

    return this.prisma.$transaction(async (tx) => {
      const target = await tx.account.findUnique({
        where: { id: input.targetAccountId },
        select: CHART_ACCOUNT_SAFE_SELECT,
      });
      if (target === null) {
        throw new NotFoundException('La cuenta destino no existe');
      }
      if (target.status !== AccountStatus.ACTIVE) {
        throw new ConflictException('La cuenta destino debe estar activa');
      }
      if (!target.isPostable) {
        throw new ConflictException('La cuenta destino debe ser postable');
      }
      if (target.systemKey !== null && target.systemKey !== input.systemKey) {
        throw new ConflictException(
          `La cuenta destino ya sostiene otro systemKey (${target.systemKey})`,
        );
      }
      if (target.systemKey === input.systemKey) {
        // No-op real: ya es quien sostiene este systemKey.
        return toSafeChartAccount(target);
      }

      const currentHolder = await tx.account.findUnique({
        where: { systemKey: input.systemKey },
        select: { id: true, code: true },
      });

      if (currentHolder !== null) {
        await tx.account.update({
          where: { id: currentHolder.id },
          data: { systemKey: null },
        });
      }

      const updated = await tx.account.update({
        where: { id: input.targetAccountId },
        data: { systemKey: input.systemKey },
        select: CHART_ACCOUNT_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: AuditAction.ACCOUNT_SYSTEM_KEY_REASSIGNED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: updated.id,
        description: `systemKey ${input.systemKey} reasignado a la cuenta ${updated.code}`,
        metadata: {
          systemKey: input.systemKey,
          fromAccountCode: currentHolder?.code ?? null,
          toAccountCode: updated.code,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeChartAccount(updated);
    });
  }

  // ==================================================================
  // Helpers privados de jerarquía (mismo patrón que CategoriesService)
  // ==================================================================

  /**
   * Rechaza si el padre candidato no existe, no está ACTIVE, o está
   * marcado isPostable=true (una cuenta de agrupación con subcuentas
   * nunca puede ser postable — A1.2: "Parent or grouping accounts cannot
   * receive postings"). Devuelve el padre ya cargado para que el
   * llamador calcule el nivel sin una segunda consulta.
   */
  private async assertParentUsableForNewChild(
    tx: Prisma.TransactionClient,
    parentId: string,
  ): Promise<{ level: number }> {
    const parent = await tx.account.findUnique({
      where: { id: parentId },
      select: { status: true, isPostable: true, level: true },
    });
    if (parent === null) {
      throw new NotFoundException('La cuenta padre no existe');
    }
    if (parent.status !== AccountStatus.ACTIVE) {
      throw new ConflictException('La cuenta padre debe estar activa');
    }
    if (parent.isPostable) {
      throw new ConflictException(
        'No se puede agregar una subcuenta bajo una cuenta marcada como postable; desactive isPostable en la cuenta padre primero',
      );
    }
    return { level: parent.level };
  }

  /** Idéntico algoritmo que CategoriesService.assertNoCycle(). */
  private async assertNoCycle(
    tx: Prisma.TransactionClient,
    targetId: string,
    candidateParentId: string,
  ): Promise<void> {
    const visited = new Set<string>();
    let currentId: string | null = candidateParentId;
    let depth = 0;

    while (currentId !== null) {
      if (currentId === targetId) {
        throw new BadRequestException(
          'No se puede asignar como padre a la propia cuenta o a una de sus descendientes',
        );
      }
      if (visited.has(currentId)) {
        throw new BadRequestException(
          'La jerarquía de cuentas está corrupta: se detectó un ciclo existente',
        );
      }
      visited.add(currentId);

      depth += 1;
      if (depth > MAX_ANCESTOR_DEPTH) {
        throw new BadRequestException(
          'La jerarquía de cuentas excede la profundidad máxima permitida',
        );
      }

      const row: { parentId: string | null } | null =
        await tx.account.findUnique({
          where: { id: currentId },
          select: { parentId: true },
        });
      currentId = row?.parentId ?? null;
    }
  }

  /**
   * A1.2 — "protect historically used accounts": cambiar la naturaleza
   * contable (`type`) de una cuenta que YA tiene al menos un asiento
   * posteado es un riesgo de integridad (reinterpretaría retroactivamente
   * la semántica de ese historial), no una edición cosmética. name/
   * parentId/isPostable→false siguen libres: ninguno de esos reescribe ni
   * reinterpreta un AccountingEntryLine ya existente.
   */
  private async assertTypeChangeAllowed(
    tx: Prisma.TransactionClient,
    accountId: string,
  ): Promise<void> {
    const existingLine = await tx.accountingEntryLine.findFirst({
      where: { accountId },
      select: { id: true },
    });
    if (existingLine !== null) {
      throw new ConflictException(
        'No se puede cambiar el tipo de una cuenta con asientos contables históricos',
      );
    }
  }

  /** Una cuenta con subcuentas nunca puede volverse postable (regla simétrica de assertParentUsableForNewChild). */
  private async assertCanBecomePostable(
    tx: Prisma.TransactionClient,
    accountId: string,
  ): Promise<void> {
    const childCount = await tx.account.count({
      where: { parentId: accountId },
    });
    if (childCount > 0) {
      throw new ConflictException(
        'No se puede marcar como postable: esta cuenta tiene subcuentas',
      );
    }
  }
}

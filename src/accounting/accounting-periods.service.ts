import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountingPeriodStatus, Prisma, RoleName } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import {
  ACCOUNTING_PERIOD_SAFE_SELECT,
  toSafeAccountingPeriod,
} from './mappers/accounting-period.mapper';
import { AccountingPeriodStatusActionInput } from './types/accounting-period-status-action.input';
import { CreateAccountingPeriodInput } from './types/create-accounting-period.input';
import { ListAccountingPeriodsQuery } from './types/list-accounting-periods.query';
import { SafeAccountingPeriod } from './types/safe-accounting-period';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

const AUDIT_MODULE = 'ACCOUNTING';
const AUDIT_ENTITY_TYPE = 'AccountingPeriod';

/**
 * Mismo alcance de lectura que el resto del dominio contable (A2.1,
 * kickoff aprobado: "MANAGEMENT has read-only access"; SELLER/WAREHOUSE
 * sin ningún acceso, mismo criterio ya cerrado en P6-E4/A1.5).
 */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
]);

function assertCanReadPeriods(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar los periodos contables',
    );
  }
}

/** Único rol autorizado a administrar periodos (A2.1: "ADMIN manages periods"). */
function assertCanMutatePeriods(requesterRole: RoleName): void {
  if (requesterRole !== RoleName.ADMIN) {
    throw new ForbiddenException(
      'No tiene permisos para administrar periodos contables',
    );
  }
}

function periodLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Administración EXPLÍCITA del ciclo de vida de periodos contables
 * (Fase A2.1/A2.6): listar, consultar, abrir/crear por adelantado, cerrar
 * y reabrir. Nunca escribe AccountingEntry ni decide por sí mismo si un
 * posteo puede entrar a un periodo — esa validación (y la auto-creación
 * implícita del periodo en curso) vive exclusivamente en
 * AccountingEngine.resolvePeriodAndAssignNumber(), que nunca pasa por este
 * servicio.
 */
@Injectable()
export class AccountingPeriodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async listPeriods(
    query: ListAccountingPeriodsQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeAccountingPeriod>> {
    assertCanReadPeriods(requesterRole);

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

    const where: Prisma.AccountingPeriodWhereInput = {};
    if (query.year !== undefined) {
      where.year = query.year;
    }
    if (query.status !== undefined) {
      where.status = query.status;
    }

    const [rows, total] = await Promise.all([
      this.prisma.accountingPeriod.findMany({
        where,
        select: ACCOUNTING_PERIOD_SAFE_SELECT,
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.accountingPeriod.count({ where }),
    ]);

    return {
      data: rows.map(toSafeAccountingPeriod),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findPeriodById(
    id: string,
    requesterRole: RoleName,
  ): Promise<SafeAccountingPeriod> {
    assertCanReadPeriods(requesterRole);

    const row = await this.prisma.accountingPeriod.findUnique({
      where: { id },
      select: ACCOUNTING_PERIOD_SAFE_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('Periodo contable no encontrado');
    }
    return toSafeAccountingPeriod(row);
  }

  /**
   * Apertura MANUAL explícita (A2.6), distinta de la auto-creación
   * implícita de AccountingEngine: nunca necesaria para la operación
   * comercial normal (ver A2.4), pero permite a ADMIN inicializar por
   * adelantado un periodo futuro con su propia auditoría.
   */
  async createPeriod(
    input: CreateAccountingPeriodInput,
  ): Promise<SafeAccountingPeriod> {
    assertCanMutatePeriods(input.requesterRole);
    this.assertValidYearMonth(input.year, input.month);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.accountingPeriod.findUnique({
        where: { year_month: { year: input.year, month: input.month } },
        select: { id: true },
      });
      if (existing !== null) {
        throw new ConflictException(
          `Ya existe el periodo contable ${periodLabel(input.year, input.month)}`,
        );
      }

      const created = await tx.accountingPeriod.create({
        data: { year: input.year, month: input.month },
        select: ACCOUNTING_PERIOD_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: AuditAction.ACCOUNTING_PERIOD_OPENED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: created.id,
        description: `Periodo contable ${periodLabel(input.year, input.month)} abierto`,
        metadata: { year: input.year, month: input.month },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeAccountingPeriod(created);
    });
  }

  /**
   * Cierra un periodo OPEN (A2.1/A2.6). A partir del commit de esta
   * transacción, ningún posteo nuevo puede entrar a este periodo:
   * AccountingEngine.resolvePeriodAndAssignNumber() hace su propio UPDATE
   * condicionado a status='OPEN' sobre esta misma fila, así que cualquier
   * transacción de posteo que ya tuviera el lock de esta fila en vuelo
   * termina (confirma o revierte) antes de que este UPDATE pueda
   * proceder — nunca al revés.
   */
  async closePeriod(
    input: AccountingPeriodStatusActionInput,
  ): Promise<SafeAccountingPeriod> {
    assertCanMutatePeriods(input.requesterRole);

    return this.prisma.$transaction(async (tx) => {
      const period = await tx.accountingPeriod.findUnique({
        where: { id: input.periodId },
        select: ACCOUNTING_PERIOD_SAFE_SELECT,
      });
      if (period === null) {
        throw new NotFoundException('Periodo contable no encontrado');
      }
      if (period.status === AccountingPeriodStatus.CLOSED) {
        throw new ConflictException('El periodo contable ya está cerrado');
      }

      const closedAt = new Date();
      const updated = await tx.accountingPeriod.update({
        where: { id: input.periodId },
        data: {
          status: AccountingPeriodStatus.CLOSED,
          closedAt,
          closedByUserId: input.actorUserId,
        },
        select: ACCOUNTING_PERIOD_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: AuditAction.ACCOUNTING_PERIOD_CLOSED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: updated.id,
        description: `Periodo contable ${periodLabel(period.year, period.month)} cerrado`,
        metadata: { year: period.year, month: period.month },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeAccountingPeriod(updated);
    });
  }

  /**
   * Reabre un periodo CLOSED (A2.1/A2.6): SIEMPRE una acción explícita y
   * auditada de ADMIN — AccountingEngine nunca reabre un periodo por sí
   * mismo bajo ninguna circunstancia. closedAt/closedByUserId del cierre
   * anterior se conservan sin cambios (evidencia histórica de ESE cierre);
   * solo reopenedAt/reopenedByUserId se actualizan.
   */
  async reopenPeriod(
    input: AccountingPeriodStatusActionInput,
  ): Promise<SafeAccountingPeriod> {
    assertCanMutatePeriods(input.requesterRole);

    return this.prisma.$transaction(async (tx) => {
      const period = await tx.accountingPeriod.findUnique({
        where: { id: input.periodId },
        select: ACCOUNTING_PERIOD_SAFE_SELECT,
      });
      if (period === null) {
        throw new NotFoundException('Periodo contable no encontrado');
      }
      if (period.status === AccountingPeriodStatus.OPEN) {
        throw new ConflictException('El periodo contable ya está abierto');
      }

      const reopenedAt = new Date();
      const updated = await tx.accountingPeriod.update({
        where: { id: input.periodId },
        data: {
          status: AccountingPeriodStatus.OPEN,
          reopenedAt,
          reopenedByUserId: input.actorUserId,
        },
        select: ACCOUNTING_PERIOD_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: AuditAction.ACCOUNTING_PERIOD_REOPENED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: updated.id,
        description: `Periodo contable ${periodLabel(period.year, period.month)} reabierto`,
        metadata: { year: period.year, month: period.month },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeAccountingPeriod(updated);
    });
  }

  private assertValidYearMonth(year: number, month: number): void {
    if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
      throw new BadRequestException(
        `year debe ser un entero entre ${MIN_YEAR} y ${MAX_YEAR}`,
      );
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException('month debe ser un entero entre 1 y 12');
    }
  }
}

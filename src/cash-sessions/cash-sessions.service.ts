import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CashSessionStatus, Prisma, RoleName } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import {
  endOfBusinessDayExclusiveUtc,
  isValidDateOnly,
  startOfBusinessDayUtc,
} from '../common/date/business-date';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import { parseOpeningAmount } from './cash-session-calculator';
import {
  CASH_SESSION_SAFE_SELECT,
  toSafeCashSession,
} from './mappers/cash-session.mapper';
import { ListCashSessionsQuery } from './types/list-cash-sessions.query';
import { OpenCashSessionInput } from './types/open-cash-session.input';
import { SafeCashSession } from './types/safe-cash-session';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Estados considerados "sin resolver" — mismo criterio que el índice único parcial `cash_sessions_one_unresolved_per_user`. */
const UNRESOLVED_STATUSES: CashSessionStatus[] = [
  CashSessionStatus.OPEN,
  CashSessionStatus.PENDING_APPROVAL,
];

const AUDIT_ENTITY_TYPE = 'CashSession';
const AUDIT_MODULE = 'CASH_SESSIONS';

/**
 * Cobradores actuales (Ticket B, Bloque B2 §2): los únicos roles con algún
 * interés operativo en abrir/tener una caja propia. MANAGEMENT no abre
 * caja porque hoy no puede registrar Payments; WAREHOUSE no tiene ningún
 * acceso a este dominio.
 */
const OPEN_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.SELLER,
]);

/** Mismo conjunto que OPEN_ROLES: solo quien puede abrir una caja puede tener una "actual". */
const CURRENT_ROLES: ReadonlySet<RoleName> = OPEN_ROLES;

/** Lectura de historial/detalle: ADMIN y MANAGEMENT sin restricción de propiedad, SELLER acotado a lo propio (nunca WAREHOUSE). */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.SELLER,
]);

/** Roles sin ninguna restricción de propiedad al listar/leer detalle. */
const UNRESTRICTED_READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
]);

function assertCanOpenCashSession(requesterRole: RoleName): void {
  if (!OPEN_ROLES.has(requesterRole)) {
    throw new ForbiddenException('No tiene permisos para abrir una caja');
  }
}

function assertCanReadOwnCurrent(requesterRole: RoleName): void {
  if (!CURRENT_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar una caja actual',
    );
  }
}

function assertCanListCashSessions(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar arqueos de caja',
    );
  }
}

function assertCanReadCashSession(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar arqueos de caja',
    );
  }
}

/**
 * Administración de arqueos de caja — apertura y lectura únicamente
 * (Ticket B post-MVP, Bloque B2: sin cierre, sin cálculo de efectivo
 * esperado, sin aprobación/rechazo, sin resumen por método — eso llega en
 * bloques posteriores). PaymentEngine no se toca en este bloque:
 * Payment.cashSessionId sigue sin asignarse en ningún flujo de cobro
 * (Bloque B4).
 */
@Injectable()
export class CashSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Apertura manual (nunca automática al iniciar sesión). El servidor fija
   * userId/status/openedAt siempre — el DTO nunca los acepta (ver
   * OpenCashSessionInput). Verificación amistosa previa (mensaje de error
   * claro) + el índice único parcial `cash_sessions_one_unresolved_per_user`
   * como autoridad final de concurrencia: dos aperturas simultáneas del
   * mismo usuario nunca deben producir un error crudo de Prisma/Postgres —
   * ambas rutas (chequeo previo perdedor, o P2002 de una carrera real)
   * terminan en el mismo 409 limpio.
   */
  async open(input: OpenCashSessionInput): Promise<SafeCashSession> {
    assertCanOpenCashSession(input.requesterRole);
    const openingAmount = parseOpeningAmount(input.openingAmount);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.cashSession.findFirst({
          where: {
            userId: input.actorUserId,
            status: { in: UNRESOLVED_STATUSES },
          },
          select: { id: true },
        });
        if (existing !== null) {
          throw new ConflictException(
            'Ya tiene una caja sin resolver (abierta o pendiente de aprobación)',
          );
        }

        const created = await tx.cashSession.create({
          data: {
            userId: input.actorUserId,
            status: CashSessionStatus.OPEN,
            openingAmount,
          },
          select: CASH_SESSION_SAFE_SELECT,
        });

        await this.auditService.record({
          userId: input.actorUserId,
          module: AUDIT_MODULE,
          action: AuditAction.CASH_SESSION_OPENED,
          entityType: AUDIT_ENTITY_TYPE,
          entityId: created.id,
          description: `Caja abierta con monto inicial ${openingAmount.toFixed(2)}`,
          metadata: {
            cashSessionId: created.id,
            userId: input.actorUserId,
            openingAmount: openingAmount.toFixed(2),
          },
          ipAddress: input.ipAddress ?? null,
          client: tx,
        });

        return toSafeCashSession(created);
      });
    } catch (error) {
      // Segunda línea de defensa contra la carrera real (dos aperturas
      // simultáneas ganan ambas el chequeo previo): el índice único
      // parcial cash_sessions_one_unresolved_per_user es la autoridad
      // final, y aquí se traduce el P2002 crudo en el mismo
      // ConflictException limpio — mismo patrón exacto que
      // ElectronicDocumentsService.createDocumentTransaction() con
      // electronic_documents_one_primary_per_sale.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Ya tiene una caja sin resolver (abierta o pendiente de aprobación)',
        );
      }
      throw error;
    }
  }

  /**
   * Caja sin resolver del actor autenticado (OPEN o PENDING_APPROVAL,
   * nunca CLOSED). El invariante de "como máximo una fila sin resolver por
   * usuario" (índice único parcial) garantiza que a lo sumo una fila
   * puede coincidir. PENDING_APPROVAL ya se contempla aquí desde B2 —ver
   * §15 del plan aprobado— aunque ningún flujo de este bloque pueda
   * producir ese estado todavía.
   */
  async getCurrent(actor: AuthenticatedUser): Promise<SafeCashSession> {
    assertCanReadOwnCurrent(actor.role);

    const row = await this.prisma.cashSession.findFirst({
      where: { userId: actor.id, status: { in: UNRESOLVED_STATUSES } },
      select: CASH_SESSION_SAFE_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('No tiene una caja sin resolver');
    }
    return toSafeCashSession(row);
  }

  /**
   * Historial paginado. SELLER queda SIEMPRE forzado a userId=actor.id sin
   * importar lo que envíe en query.userId (nunca se confía en el query
   * param para autorización, ver §10/§11 del plan aprobado) — ADMIN/
   * MANAGEMENT sin restricción de propiedad, con query.userId como filtro
   * opcional real. Orden fijo openedAt DESC, id DESC (mismo criterio que
   * ListPaymentsQueryDto: sin depender del orden de inserción).
   */
  async list(
    query: ListCashSessionsQuery,
    actor: AuthenticatedUser,
  ): Promise<PaginatedResult<SafeCashSession>> {
    assertCanListCashSessions(actor.role);
    this.assertValidDateRangeQuery(query);

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

    const conditions: Prisma.CashSessionWhereInput[] = [];

    if (UNRESTRICTED_READ_ROLES.has(actor.role)) {
      if (query.userId !== undefined) {
        conditions.push({ userId: query.userId });
      }
    } else {
      // SELLER: el query param se ignora por completo — nunca se combina
      // ni se valida contra actor.id, simplemente no se lee.
      conditions.push({ userId: actor.id });
    }

    if (query.status !== undefined) {
      conditions.push({ status: query.status });
    }
    if (query.openedFrom !== undefined) {
      conditions.push({
        openedAt: { gte: startOfBusinessDayUtc(query.openedFrom) },
      });
    }
    if (query.openedTo !== undefined) {
      conditions.push({
        openedAt: { lt: endOfBusinessDayExclusiveUtc(query.openedTo) },
      });
    }
    if (query.closedFrom !== undefined) {
      conditions.push({
        closedAt: { gte: startOfBusinessDayUtc(query.closedFrom) },
      });
    }
    if (query.closedTo !== undefined) {
      conditions.push({
        closedAt: { lt: endOfBusinessDayExclusiveUtc(query.closedTo) },
      });
    }
    if (query.hasDifference === true) {
      conditions.push({ differenceAmount: { not: new Prisma.Decimal(0) } });
    } else if (query.hasDifference === false) {
      conditions.push({ differenceAmount: new Prisma.Decimal(0) });
    }

    const where: Prisma.CashSessionWhereInput =
      conditions.length > 0 ? { AND: conditions } : {};

    const [rows, total] = await Promise.all([
      this.prisma.cashSession.findMany({
        where,
        select: CASH_SESSION_SAFE_SELECT,
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.cashSession.count({ where }),
    ]);

    return {
      data: rows.map(toSafeCashSession),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /**
   * Detalle por ID. ADMIN/MANAGEMENT pueden leer cualquiera; SELLER solo
   * la suya. Una sesión ajena para SELLER se trata como inexistente (404),
   * nunca 403 — mismo criterio ya establecido en Payments (§71: "pago que
   * pertenece a otra venta -> 404, sin revelar la existencia cruzada"):
   * revelar que una CashSession de otro usuario EXISTE (aunque sea con un
   * 403) ya es información que un SELLER no debería poder confirmar.
   */
  async getDetail(
    id: string,
    actor: AuthenticatedUser,
  ): Promise<SafeCashSession> {
    assertCanReadCashSession(actor.role);

    const row = await this.prisma.cashSession.findUnique({
      where: { id },
      select: CASH_SESSION_SAFE_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('La caja no existe');
    }
    if (!UNRESTRICTED_READ_ROLES.has(actor.role) && row.userId !== actor.id) {
      throw new NotFoundException('La caja no existe');
    }
    return toSafeCashSession(row);
  }

  private assertValidDateRangeQuery(query: ListCashSessionsQuery): void {
    for (const [field, value] of [
      ['openedFrom', query.openedFrom],
      ['openedTo', query.openedTo],
      ['closedFrom', query.closedFrom],
      ['closedTo', query.closedTo],
    ] as const) {
      if (value !== undefined && !isValidDateOnly(value)) {
        throw new BadRequestException(
          `${field} debe ser una fecha válida en formato YYYY-MM-DD`,
        );
      }
    }
    if (
      query.openedFrom !== undefined &&
      query.openedTo !== undefined &&
      query.openedFrom > query.openedTo
    ) {
      throw new BadRequestException(
        'openedFrom no puede ser posterior a openedTo',
      );
    }
    if (
      query.closedFrom !== undefined &&
      query.closedTo !== undefined &&
      query.closedFrom > query.closedTo
    ) {
      throw new BadRequestException(
        'closedFrom no puede ser posterior a closedTo',
      );
    }
  }
}

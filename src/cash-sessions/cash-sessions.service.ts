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
import {
  assertClosingObservationRequiredForDifference,
  calculateCashSessionTotals,
  calculateDifference,
  normalizeOptionalCashSessionText,
  normalizeRejectionReason,
  parseCountedCashAmount,
  parseOpeningAmount,
} from './cash-session-calculator';
import {
  CASH_SESSION_LINKED_PAYMENT_SELECT,
  CASH_SESSION_PAYMENT_METHOD_SUMMARY_SAFE_SELECT,
  CASH_SESSION_SAFE_SELECT,
  CashSessionSafeRow,
  toSafeCashSession,
  toSafeCashSessionMethodBreakdownRow,
} from './mappers/cash-session.mapper';
import { ApproveCashSessionInput } from './types/approve-cash-session.input';
import { CloseCashSessionInput } from './types/close-cash-session.input';
import { ListCashSessionsQuery } from './types/list-cash-sessions.query';
import { OpenCashSessionInput } from './types/open-cash-session.input';
import { RejectCashSessionInput } from './types/reject-cash-session.input';
import {
  SafeCashSession,
  SafeCashSessionDetail,
} from './types/safe-cash-session';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Fila mínima bloqueada de CashSession, leída directamente vía SQL crudo dentro de close() (mismo patrón que LockedSaleRow en payments.service.ts). */
interface LockedCashSessionRow {
  id: string;
  userId: string;
  status: CashSessionStatus;
  openingAmount: Prisma.Decimal;
}

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

/** Mismo conjunto que OPEN_ROLES (Ticket B, Bloque B3 §3): solo quien puede abrir una caja puede cerrar la suya. */
const CLOSE_ROLES: ReadonlySet<RoleName> = OPEN_ROLES;

/** Revisores de un descuadre (Ticket B, Bloque B3 §13/§18): nunca SELLER, nunca WAREHOUSE. */
const REVIEW_ROLES: ReadonlySet<RoleName> = new Set([
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

function assertCanCloseCashSession(requesterRole: RoleName): void {
  if (!CLOSE_ROLES.has(requesterRole)) {
    throw new ForbiddenException('No tiene permisos para cerrar una caja');
  }
}

function assertCanReviewCashSession(requesterRole: RoleName): void {
  if (!REVIEW_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para aprobar o rechazar un descuadre de caja',
    );
  }
}

/**
 * Regla final aprobada (Ticket B, Bloque B3 §14/§19): un usuario nunca
 * puede aprobar ni rechazar su propia caja, sin importar su rol activo —
 * invariante de IDENTIDAD, nunca de rol (nunca se inspecciona la unión de
 * roles asignados). Se evalúa ANTES que el estado (PENDING_APPROVAL o no):
 * la prohibición de autorrevisión es absoluta, no condicionada al estado
 * actual de la caja.
 */
function assertReviewerIsNotOwner(
  ownerUserId: string,
  reviewerUserId: string,
): void {
  if (ownerUserId === reviewerUserId) {
    throw new ForbiddenException(
      'No puede aprobar ni rechazar el descuadre de su propia caja',
    );
  }
}

/**
 * Administración de arqueos de caja (Ticket B post-MVP, Bloques B2+B3):
 * apertura, lectura (actual/historial/detalle) y ahora el flujo completo de
 * cierre — exacto (OPEN -> CLOSED directo) o con descuadre
 * (OPEN -> PENDING_APPROVAL -> CLOSED por aprobación, o -> OPEN de nuevo
 * por rechazo). PaymentEngine SIGUE sin tocarse en este bloque:
 * Payment.cashSessionId sigue sin asignarse en ningún flujo de cobro real
 * (eso es exclusivo del Bloque B4) — el cálculo de efectivo esperado de
 * este bloque solo LEE Payments ya vinculados por fixtures de prueba o por
 * un futuro B4, nunca los crea ni los vincula él mismo.
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
   * Cierre de la caja sin resolver del actor autenticado (Ticket B, Bloque
   * B3). Siempre opera sobre "la caja actual del actor" — nunca una
   * cashSessionId arbitraria del body (§3 del plan aprobado). Bloqueo
   * `SELECT ... FOR UPDATE` sobre esa fila DENTRO de la misma transacción
   * (§9): la misma fila que un futuro Bloque B4 bloqueará también durante
   * el registro de un Payment, para serializar cierre vs. cobro. Solo OPEN
   * puede enviarse a cierre; PENDING_APPROVAL responde 409 (inmutabilidad
   * mientras está pendiente, §12) — nunca se sobrescribe un snapshot
   * pendiente con un segundo intento.
   */
  async close(input: CloseCashSessionInput): Promise<SafeCashSession> {
    assertCanCloseCashSession(input.requesterRole);
    const countedCashAmount = parseCountedCashAmount(input.countedCashAmount);
    const providedObservation = normalizeOptionalCashSessionText(
      input.closingObservation,
    );

    return this.prisma.$transaction(async (tx) => {
      const lockedRows = await tx.$queryRaw<LockedCashSessionRow[]>(Prisma.sql`
        SELECT id, user_id AS "userId", status, opening_amount AS "openingAmount"
        FROM cash_sessions
        WHERE user_id = ${input.actorUserId}::uuid
          AND status IN ('OPEN', 'PENDING_APPROVAL')
        FOR UPDATE
      `);
      const session = lockedRows[0];
      if (session === undefined) {
        throw new NotFoundException('No tiene una caja sin resolver');
      }
      if (session.status !== CashSessionStatus.OPEN) {
        throw new ConflictException(
          'La caja está pendiente de aprobación; no puede volver a cerrarse',
        );
      }

      const linkedPayments = await tx.payment.findMany({
        where: { cashSessionId: session.id },
        select: CASH_SESSION_LINKED_PAYMENT_SELECT,
      });
      const totals = calculateCashSessionTotals(
        session.openingAmount,
        linkedPayments,
      );
      const differenceAmount = calculateDifference(
        countedCashAmount,
        totals.expectedCashAmount,
      );
      const isZeroDifference = differenceAmount.isZero();

      if (!isZeroDifference) {
        assertClosingObservationRequiredForDifference(
          differenceAmount,
          providedObservation,
        );
      }

      // §8 del plan aprobado: "antes de escribir un snapshot de cierre
      // nuevo desde OPEN, asegurar que no existan filas de resumen
      // obsoletas para esa sesión" — normalmente no debería haber ninguna
      // (solo rechazo las elimina explícitamente), pero se hace de forma
      // defensiva e idempotente, nunca asumida.
      await tx.cashSessionPaymentMethodSummary.deleteMany({
        where: { cashSessionId: session.id },
      });

      const now = new Date();
      const updated = await tx.cashSession.update({
        where: { id: session.id },
        data: isZeroDifference
          ? {
              status: CashSessionStatus.CLOSED,
              closeRequestedAt: now,
              expectedCashAmount: totals.expectedCashAmount,
              countedCashAmount,
              differenceAmount,
              closingObservation: providedObservation,
              closedAt: now,
            }
          : {
              status: CashSessionStatus.PENDING_APPROVAL,
              closeRequestedAt: now,
              expectedCashAmount: totals.expectedCashAmount,
              countedCashAmount,
              differenceAmount,
              closingObservation: providedObservation,
            },
        select: CASH_SESSION_SAFE_SELECT,
      });

      if (totals.breakdown.length > 0) {
        await tx.cashSessionPaymentMethodSummary.createMany({
          data: totals.breakdown.map((row) => ({
            cashSessionId: session.id,
            paymentMethodId: row.paymentMethodId,
            paymentMethodCode: row.paymentMethodCode,
            paymentMethodName: row.paymentMethodName,
            totalAmount: row.totalAmount,
          })),
        });
      }

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: isZeroDifference
          ? AuditAction.CASH_SESSION_CLOSED
          : AuditAction.CASH_SESSION_CLOSING_REQUESTED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: session.id,
        description: isZeroDifference
          ? `Caja cerrada sin descuadre (contado ${countedCashAmount.toFixed(2)})`
          : `Cierre con descuadre solicitado (diferencia ${differenceAmount.toFixed(2)})`,
        metadata: isZeroDifference
          ? {
              cashSessionId: session.id,
              userId: input.actorUserId,
              expectedCashAmount: totals.expectedCashAmount.toFixed(2),
              countedCashAmount: countedCashAmount.toFixed(2),
              differenceAmount: differenceAmount.toFixed(2),
            }
          : {
              cashSessionId: session.id,
              userId: input.actorUserId,
              expectedCashAmount: totals.expectedCashAmount.toFixed(2),
              countedCashAmount: countedCashAmount.toFixed(2),
              differenceAmount: differenceAmount.toFixed(2),
              closingObservation: providedObservation,
            },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeCashSession(updated);
    });
  }

  /**
   * Aprobación de un descuadre (Ticket B, Bloque B3). NUNCA recalcula
   * expectedCashAmount/countedCashAmount/differenceAmount/resumen por
   * método (§15): el snapshot de PENDING_APPROVAL queda congelado y la
   * aprobación acepta EXACTAMENTE ese snapshot. Autorrevisión prohibida
   * por identidad (§14), evaluada antes que el estado. Transición atómica
   * condicional `UPDATE ... WHERE status = 'PENDING_APPROVAL'` (§16): si
   * cero filas se actualizan, alguien más ya resolvió la caja -> 409,
   * nunca confiar solo en un findUnique previo.
   */
  async approve(input: ApproveCashSessionInput): Promise<SafeCashSession> {
    assertCanReviewCashSession(input.requesterRole);
    const comment = normalizeOptionalCashSessionText(input.comment);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.cashSession.findUnique({
        where: { id: input.cashSessionId },
        select: {
          id: true,
          userId: true,
          status: true,
          expectedCashAmount: true,
          countedCashAmount: true,
          differenceAmount: true,
        },
      });
      if (existing === null) {
        throw new NotFoundException('La caja no existe');
      }
      assertReviewerIsNotOwner(existing.userId, input.actorUserId);
      if (existing.status !== CashSessionStatus.PENDING_APPROVAL) {
        throw new ConflictException('La caja no está pendiente de aprobación');
      }

      const now = new Date();
      const affectedRows = await tx.$executeRaw`
        UPDATE cash_sessions
        SET status = 'CLOSED'::"CashSessionStatus",
            closed_at = ${now},
            approved_by_user_id = ${input.actorUserId}::uuid,
            approved_at = ${now},
            approval_comment = ${comment},
            updated_at = ${now}
        WHERE id = ${input.cashSessionId}::uuid
          AND status = 'PENDING_APPROVAL'::"CashSessionStatus"
      `;
      if (affectedRows === 0) {
        throw new ConflictException(
          'La caja ya fue resuelta por otra operación',
        );
      }

      const updated = await tx.cashSession.findUniqueOrThrow({
        where: { id: input.cashSessionId },
        select: CASH_SESSION_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: AuditAction.CASH_SESSION_DISCREPANCY_APPROVED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: input.cashSessionId,
        description: `Descuadre aprobado (diferencia ${existing.differenceAmount?.toFixed(2) ?? '0.00'})`,
        metadata: {
          cashSessionId: input.cashSessionId,
          ownerUserId: existing.userId,
          reviewerUserId: input.actorUserId,
          expectedCashAmount: existing.expectedCashAmount?.toFixed(2) ?? null,
          countedCashAmount: existing.countedCashAmount?.toFixed(2) ?? null,
          differenceAmount: existing.differenceAmount?.toFixed(2) ?? null,
          comment,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeCashSession(updated);
    });
  }

  /**
   * Rechazo de un descuadre (Ticket B, Bloque B3). Orden exacto dentro de
   * UNA transacción (§21): 1) confirmar PENDING_APPROVAL + 2) revisor !=
   * dueño (§19) + 3) capturar el snapshot pendiente (para auditoría, antes
   * de limpiarlo) + 4) eliminar el resumen por método + 5-6) transición a
   * OPEN con el snapshot de cierre limpiado (en un único UPDATE atómico
   * condicional, §22) + 7) auditar. Si la transición pierde la carrera (0
   * filas afectadas), toda la transacción se revierte — incluida la
   * eliminación del resumen del paso 4 — así que nunca se borra el resumen
   * de una caja que en realidad ya ganó otra resolución (p. ej. una
   * aprobación concurrente).
   */
  async reject(input: RejectCashSessionInput): Promise<SafeCashSession> {
    assertCanReviewCashSession(input.requesterRole);
    const reason = normalizeRejectionReason(input.reason);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.cashSession.findUnique({
        where: { id: input.cashSessionId },
        select: {
          id: true,
          userId: true,
          status: true,
          expectedCashAmount: true,
          countedCashAmount: true,
          differenceAmount: true,
          closingObservation: true,
        },
      });
      if (existing === null) {
        throw new NotFoundException('La caja no existe');
      }
      assertReviewerIsNotOwner(existing.userId, input.actorUserId);
      if (existing.status !== CashSessionStatus.PENDING_APPROVAL) {
        throw new ConflictException('La caja no está pendiente de aprobación');
      }

      await tx.cashSessionPaymentMethodSummary.deleteMany({
        where: { cashSessionId: input.cashSessionId },
      });

      const now = new Date();
      const affectedRows = await tx.$executeRaw`
        UPDATE cash_sessions
        SET status = 'OPEN'::"CashSessionStatus",
            close_requested_at = NULL,
            expected_cash_amount = NULL,
            counted_cash_amount = NULL,
            difference_amount = NULL,
            closing_observation = NULL,
            closed_at = NULL,
            approved_by_user_id = NULL,
            approved_at = NULL,
            approval_comment = NULL,
            updated_at = ${now}
        WHERE id = ${input.cashSessionId}::uuid
          AND status = 'PENDING_APPROVAL'::"CashSessionStatus"
      `;
      if (affectedRows === 0) {
        throw new ConflictException(
          'La caja ya fue resuelta por otra operación',
        );
      }

      const updated = await tx.cashSession.findUniqueOrThrow({
        where: { id: input.cashSessionId },
        select: CASH_SESSION_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: AUDIT_MODULE,
        action: AuditAction.CASH_SESSION_DISCREPANCY_REJECTED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: input.cashSessionId,
        description: `Descuadre rechazado: ${reason}`,
        metadata: {
          cashSessionId: input.cashSessionId,
          ownerUserId: existing.userId,
          reviewerUserId: input.actorUserId,
          reason,
          previousExpectedCashAmount:
            existing.expectedCashAmount?.toFixed(2) ?? null,
          previousCountedCashAmount:
            existing.countedCashAmount?.toFixed(2) ?? null,
          previousDifferenceAmount:
            existing.differenceAmount?.toFixed(2) ?? null,
          previousClosingObservation: existing.closingObservation,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeCashSession(updated);
    });
  }

  /**
   * Caja sin resolver del actor autenticado (OPEN o PENDING_APPROVAL,
   * nunca CLOSED). El invariante de "como máximo una fila sin resolver por
   * usuario" (índice único parcial) garantiza que a lo sumo una fila
   * puede coincidir. Desde el Bloque B3, la respuesta viene enriquecida
   * (ver enrichWithBreakdown()): live* mientras OPEN, breakdownByMethod
   * congelado mientras PENDING_APPROVAL.
   */
  async getCurrent(actor: AuthenticatedUser): Promise<SafeCashSessionDetail> {
    assertCanReadOwnCurrent(actor.role);

    const row = await this.prisma.cashSession.findFirst({
      where: { userId: actor.id, status: { in: UNRESOLVED_STATUSES } },
      select: CASH_SESSION_SAFE_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('No tiene una caja sin resolver');
    }
    return this.enrichWithBreakdown(row);
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
  ): Promise<SafeCashSessionDetail> {
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
    return this.enrichWithBreakdown(row);
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

  /**
   * Enriquece una fila base (Ticket B, Bloque B3 §24/§25/§26) — solo para
   * current/detail, NUNCA para list() (historial liviano a propósito, sin
   * N+1 de agregación por fila). Exactamente una de las dos ramas aplica:
   * OPEN recalcula en vivo desde los Payment ACTIVE vinculados vigentes
   * (nunca persistido, siempre fresco); PENDING_APPROVAL/CLOSED devuelve el
   * resumen YA CONGELADO de CashSessionPaymentMethodSummary, nunca
   * recalculado desde el estado actual de Payment — un Payment cancelado
   * después del cierre nunca altera esta lectura (§27).
   */
  private async enrichWithBreakdown(
    row: CashSessionSafeRow,
  ): Promise<SafeCashSessionDetail> {
    const base = toSafeCashSession(row);

    if (row.status === CashSessionStatus.OPEN) {
      const linkedPayments = await this.prisma.payment.findMany({
        where: { cashSessionId: row.id },
        select: CASH_SESSION_LINKED_PAYMENT_SELECT,
      });
      const totals = calculateCashSessionTotals(
        row.openingAmount,
        linkedPayments,
      );
      return {
        ...base,
        liveCollectionsTotal: totals.collectionsTotal.toFixed(2),
        liveCashCollectionsTotal: totals.cashCollectionsTotal.toFixed(2),
        liveExpectedCashAmount: totals.expectedCashAmount.toFixed(2),
        liveBreakdownByMethod: totals.breakdown.map(
          toSafeCashSessionMethodBreakdownRow,
        ),
        breakdownByMethod: null,
      };
    }

    const summaryRows =
      await this.prisma.cashSessionPaymentMethodSummary.findMany({
        where: { cashSessionId: row.id },
        select: CASH_SESSION_PAYMENT_METHOD_SUMMARY_SAFE_SELECT,
        orderBy: [{ paymentMethodCode: 'asc' }],
      });
    return {
      ...base,
      liveCollectionsTotal: null,
      liveCashCollectionsTotal: null,
      liveExpectedCashAmount: null,
      liveBreakdownByMethod: null,
      breakdownByMethod: summaryRows.map(toSafeCashSessionMethodBreakdownRow),
    };
  }
}

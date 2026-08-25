import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import {
  endOfBusinessDayExclusiveUtc,
  isValidDateOnly,
  startOfBusinessDayUtc,
} from '../common/date/business-date';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import {
  AUDIT_LOG_DETAIL_SELECT,
  AUDIT_LOG_LIST_SELECT,
  toSafeAuditLogDetail,
  toSafeAuditLogListItem,
} from './mappers/audit-log.mapper';
import {
  SafeAuditLogDetail,
  SafeAuditLogListItem,
} from './types/safe-audit-log';
import { ListAuditLogsQuery } from './types/list-audit-logs.query';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
]);

/**
 * Defensa en profundidad: mismo criterio que assertCanReadConfiguration()/
 * assertCanReadSequences() (Fase 10, Bloques A y D) — @Roles()/RolesGuard ya
 * bloquean esto en la capa HTTP, este chequeo es una segunda línea dentro
 * del servicio, evaluada ANTES de cualquier acceso a Prisma. Cualquier rol
 * no contemplado explícitamente (incluido un valor fuera del enum conocido)
 * falla cerrado.
 */
function assertCanReadAudit(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar la auditoría del sistema',
    );
  }
}

/**
 * Consulta de solo lectura sobre AuditLog (Fase 10, Bloque E). Deliberadamente
 * separado de AuditService (infraestructura de escritura, transaccional,
 * usada por todos los emisores de auditoría del sistema): AuditQueryService
 * nunca inyecta AuditService ni llama record() — ninguna lectura de este
 * servicio genera una fila de auditoría (nunca AUDIT_VIEWED/AUDIT_SEARCHED).
 * No se exporta desde AuditModule: solo lo usa AuditController.
 */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Orden fijo createdAt DESC, id DESC (desempate determinista). El mismo
   * `where` alimenta count() y findMany() — nunca "traer todo y filtrar en
   * Node". Rol sin acceso: ForbiddenException antes de tocar Prisma.
   */
  async list(
    query: ListAuditLogsQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeAuditLogListItem>> {
    assertCanReadAudit(requesterRole);
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

    const conditions: Prisma.AuditLogWhereInput[] = [];
    if (query.from !== undefined) {
      conditions.push({
        createdAt: { gte: startOfBusinessDayUtc(query.from) },
      });
    }
    if (query.to !== undefined) {
      conditions.push({
        createdAt: { lt: endOfBusinessDayExclusiveUtc(query.to) },
      });
    }
    if (query.userId !== undefined) {
      conditions.push({ userId: query.userId });
    }
    if (query.module !== undefined) {
      conditions.push({ module: query.module });
    }
    if (query.action !== undefined) {
      conditions.push({ action: query.action });
    }
    if (query.entityType !== undefined) {
      conditions.push({ entityType: query.entityType });
    }
    if (query.entityId !== undefined) {
      conditions.push({ entityId: query.entityId });
    }

    const where: Prisma.AuditLogWhereInput =
      conditions.length > 0 ? { AND: conditions } : {};

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        select: AUDIT_LOG_LIST_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data: rows.map(toSafeAuditLogListItem),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /**
   * ipAddress depende del rol: ADMIN ve el valor real (o null si nunca se
   * registró); MANAGEMENT siempre recibe null, aunque la fila tenga un valor
   * real almacenado — la clave `ipAddress` está siempre presente en la
   * respuesta, nunca omitida condicionalmente. metadata se devuelve igual
   * para ambos roles, exactamente como se almacenó.
   */
  async findOne(
    id: string,
    requesterRole: RoleName,
  ): Promise<SafeAuditLogDetail> {
    assertCanReadAudit(requesterRole);

    const row = await this.prisma.auditLog.findUnique({
      where: { id },
      select: AUDIT_LOG_DETAIL_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('Registro de auditoría no encontrado');
    }

    return toSafeAuditLogDetail(row, {
      includeIp: requesterRole === RoleName.ADMIN,
    });
  }

  private assertValidDateRangeQuery(query: ListAuditLogsQuery): void {
    if (query.from !== undefined && !isValidDateOnly(query.from)) {
      throw new BadRequestException(
        'from debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (query.to !== undefined && !isValidDateOnly(query.to)) {
      throw new BadRequestException(
        'to debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (
      query.from !== undefined &&
      query.to !== undefined &&
      query.from > query.to
    ) {
      throw new BadRequestException('from no puede ser posterior a to');
    }
  }
}

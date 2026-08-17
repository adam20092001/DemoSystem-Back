import {
  BadRequestException,
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
  ACCOUNT_SAFE_SELECT,
  ACCOUNTING_ENTRY_DETAIL_SELECT,
  ACCOUNTING_ENTRY_LIST_SELECT,
  toSafeAccount,
  toSafeAccountingEntry,
  toSafeAccountingEntryListItem,
} from './mappers/accounting.mapper';
import { ListAccountingEntriesQuery } from './types/list-accounting-entries.query';
import { SafeAccount } from './types/safe-account';
import {
  SafeAccountingEntry,
  SafeAccountingEntryListItem,
} from './types/safe-accounting-entry';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Roles con acceso de lectura a Contabilidad básica (defensa en
 * profundidad; el controller igualmente rechaza con 403 vía guards). Más
 * estricto que Cuentas por Cobrar: ni SELLER ni WAREHOUSE tienen ningún
 * acceso — este es el libro contable interno, no una pantalla operativa
 * de ventas. `default` también falla cerrado.
 */
function hasAccountingReadAccess(role: RoleName): boolean {
  switch (role) {
    case RoleName.ADMIN:
    case RoleName.MANAGEMENT:
      return true;
    case RoleName.SELLER:
    case RoleName.WAREHOUSE:
    default:
      return false;
  }
}

/**
 * Servicio de solo lectura (Fase 8, Bloque C): consulta directa vía
 * PrismaService, sin transacción (consultas de solo lectura no la
 * necesitan). No depende de AccountingEngine: el motor solo escribe
 * dentro de las transacciones de Ventas/Pagos; este servicio nunca
 * escribe ni invoca al motor.
 */
@Injectable()
export class AccountingService {
  constructor(private readonly prisma: PrismaService) {}

  async listAccounts(requesterRole: RoleName): Promise<SafeAccount[]> {
    if (!hasAccountingReadAccess(requesterRole)) {
      // Rol sin ningún acceso: lista vacía sin tocar Prisma. Defensa en
      // profundidad; el controller igualmente rechaza esto con 403.
      return [];
    }
    const rows = await this.prisma.account.findMany({
      select: ACCOUNT_SAFE_SELECT,
      orderBy: [{ code: 'asc' }],
    });
    return rows.map(toSafeAccount);
  }

  async listEntries(
    query: ListAccountingEntriesQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeAccountingEntryListItem>> {
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

    if (!hasAccountingReadAccess(requesterRole)) {
      // Rol sin ningún acceso: página vacía sin tocar Prisma.
      return { data: [], page, limit, total: 0, totalPages: 0 };
    }

    this.assertValidDateRangeQuery(query);

    const conditions: Prisma.AccountingEntryWhereInput[] = [];
    if (query.sourceType !== undefined) {
      conditions.push({ sourceType: query.sourceType });
    }
    if (query.eventType !== undefined) {
      conditions.push({ eventType: query.eventType });
    }
    if (query.sourceId !== undefined) {
      conditions.push({ sourceId: query.sourceId });
    }
    if (query.postedFrom !== undefined) {
      conditions.push({
        postedAt: { gte: startOfBusinessDayUtc(query.postedFrom) },
      });
    }
    if (query.postedTo !== undefined) {
      conditions.push({
        postedAt: { lt: endOfBusinessDayExclusiveUtc(query.postedTo) },
      });
    }

    const where: Prisma.AccountingEntryWhereInput =
      conditions.length > 0 ? { AND: conditions } : {};

    const [rows, total] = await Promise.all([
      this.prisma.accountingEntry.findMany({
        where,
        select: ACCOUNTING_ENTRY_LIST_SELECT,
        // Decisión cerrada del Bloque C (reconfirmada en el Bloque D):
        // postedAt DESC, id DESC — asientos más recientes primero. postedAt
        // es el instante contable real del hecho de negocio (confirmación
        // de venta / cobro de pago); createdAt es solo el instante de
        // persistencia y puede diferir, así que nunca se ordena por él.
        orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.accountingEntry.count({ where }),
    ]);

    return {
      data: rows.map(toSafeAccountingEntryListItem),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findEntry(
    entryId: string,
    requesterRole: RoleName,
  ): Promise<SafeAccountingEntry> {
    if (!hasAccountingReadAccess(requesterRole)) {
      throw new NotFoundException('Asiento contable no encontrado');
    }
    const row = await this.prisma.accountingEntry.findUnique({
      where: { id: entryId },
      select: ACCOUNTING_ENTRY_DETAIL_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('Asiento contable no encontrado');
    }
    return toSafeAccountingEntry(row);
  }

  private assertValidDateRangeQuery(query: ListAccountingEntriesQuery): void {
    if (query.postedFrom !== undefined && !isValidDateOnly(query.postedFrom)) {
      throw new BadRequestException(
        'postedFrom debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (query.postedTo !== undefined && !isValidDateOnly(query.postedTo)) {
      throw new BadRequestException(
        'postedTo debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (
      query.postedFrom !== undefined &&
      query.postedTo !== undefined &&
      query.postedFrom > query.postedTo
    ) {
      throw new BadRequestException(
        'postedFrom no puede ser posterior a postedTo',
      );
    }
  }
}

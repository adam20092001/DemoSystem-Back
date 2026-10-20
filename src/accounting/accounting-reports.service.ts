import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { ExcelColumn } from '../common/excel/excel-column';
import { EXPORT_PAGE_SIZE } from '../common/excel/excel-export.constants';
import { ExcelExportService } from '../common/excel/excel-export.service';
import { toPrismaDate } from '../common/date/business-date';
import { PrismaService } from '../database/prisma.service';
import { accountNormalBalance, NormalBalance } from './account-hierarchy.utils';
import {
  assertValidAccountingDateRange,
  signedNaturalBalance,
  splitNetBalance,
} from './accounting-reports.utils';
import {
  JOURNAL_ENTRY_SELECT,
  JournalEntryQueryRow,
  LEDGER_LINE_SELECT,
  toJournalEntryRow,
  toLedgerMovementRow,
} from './mappers/accounting-reports.mapper';
import {
  JournalEntryRow,
  JournalReportQuery,
  JournalReportResult,
} from './types/journal-report.types';
import {
  LedgerMovementRow,
  LedgerReportQuery,
  LedgerReportResult,
} from './types/ledger-report.types';
import {
  TrialBalanceAccountRow,
  TrialBalanceQuery,
  TrialBalanceReportResult,
} from './types/trial-balance-report.types';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Mismo alcance de lectura que el resto del dominio contable (A3.4): ni
 * SELLER ni WAREHOUSE tienen ningún acceso; MANAGEMENT solo lee, nunca
 * escribe (estos reportes no exponen ninguna ruta de escritura nueva).
 */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
]);

function assertCanReadReports(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar los reportes contables',
    );
  }
}

function normalizePage(page: number | undefined): number {
  return page !== undefined && page > 0 ? Math.floor(page) : DEFAULT_PAGE;
}

function normalizeLimit(limit: number | undefined): number {
  return Math.min(
    limit !== undefined && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT,
    MAX_LIMIT,
  );
}

interface LedgerAccountInfo {
  id: string;
  code: string;
  name: string;
  type: Prisma.AccountGetPayload<{ select: { type: true } }>['type'];
  status: Prisma.AccountGetPayload<{ select: { status: true } }>['status'];
  normalBalance: NormalBalance;
}

/** Resultado interno completo (sin paginar) de A3.2, compartido por listado y exportación. */
interface FullLedgerComputation {
  account: LedgerAccountInfo;
  openingBalance: Prisma.Decimal;
  closingBalance: Prisma.Decimal;
  movements: LedgerMovementRow[];
}

/**
 * Servicio de SOLO LECTURA (A3): los 3 reportes contables (Diario, Mayor,
 * Balance de comprobación) derivan exclusivamente de AccountingEntry/
 * AccountingEntryLine ya persistidos por AccountingEngine — este servicio
 * nunca escribe ni invoca al motor, nunca reconstruye montos históricos a
 * partir de Sale/Quote/configuración vigente, y nunca filtra por el
 * `status`/`systemKey` ACTUAL de una cuenta para decidir qué historial
 * mostrar (un AccountingEntryLine histórico sigue apuntando por accountId
 * a la cuenta que tenía en el momento de postearse, sin importar
 * reasignaciones de systemKey o desactivaciones posteriores — A1/A2).
 */
@Injectable()
export class AccountingReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly excelExportService: ExcelExportService,
  ) {}

  // ==================================================================
  // A3.1 — Libro Diario
  // ==================================================================

  async getJournalReport(
    query: JournalReportQuery,
    requesterRole: RoleName,
  ): Promise<JournalReportResult> {
    assertCanReadReports(requesterRole);
    assertValidAccountingDateRange(
      query.accountingDateFrom,
      query.accountingDateTo,
    );

    const page = normalizePage(query.page);
    const limit = normalizeLimit(query.limit);
    const where = this.buildJournalWhere(query);

    // Revisión A3 (consistencia de lectura): findMany+count corren DENTRO
    // de la MISMA transacción REPEATABLE READ — sin esto, un asiento nuevo
    // comprometido entre ambas consultas podría dejar `total`
    // (de count) desalineado de lo que `rows` (de findMany) realmente
    // reflejó, un snapshot distinto para cada una bajo READ COMMITTED (el
    // nivel por defecto). Solo lectura: ningún lock de escritura, sin
    // tocar AccountingEngine.
    const { rows, total } = await this.prisma.$transaction(
      (tx) => this.fetchJournalPage(tx, where, (page - 1) * limit, limit),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return {
      data: rows.map(toJournalEntryRow),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      accountingDateFrom: query.accountingDateFrom,
      accountingDateTo: query.accountingDateTo,
      periodId: query.periodId ?? null,
    };
  }

  /**
   * A3.5: recorre `getJournalReport()` en lotes de EXPORT_PAGE_SIZE (mismo
   * `where`/orden que el listado normal, mismo patrón ya usado por
   * AccountsReceivableService.exportReceivablesXlsx) para exportar el
   * resultado FILTRADO COMPLETO, nunca solo la página visible.
   */
  async exportJournalXlsx(
    query: JournalReportQuery,
    requesterRole: RoleName,
  ): Promise<Buffer> {
    assertCanReadReports(requesterRole);
    assertValidAccountingDateRange(
      query.accountingDateFrom,
      query.accountingDateTo,
    );
    const where = this.buildJournalWhere(query);

    // Revisión A3: TODO el recorrido de páginas corre dentro de UNA sola
    // transacción REPEATABLE READ (nunca una transacción nueva por
    // página): así el archivo exportado refleja un único snapshot
    // consistente de principio a fin, igual que una sola llamada a la
    // API — nunca una mezcla de snapshots si un asiento se compromete a
    // mitad de la exportación.
    const entries: JournalEntryRow[] = await this.prisma.$transaction(
      async (tx) => {
        const { rows: firstRows, total } = await this.fetchJournalPage(
          tx,
          where,
          0,
          EXPORT_PAGE_SIZE,
        );
        // Revisión A3 (chequeo real de filas exportadas): esto es solo un
        // pre-chequeo RÁPIDO de falla temprana — `total` cuenta ASIENTOS,
        // nunca las líneas que realmente se escriben en el .xlsx (una fila
        // por línea, nunca por asiento). Como cada asiento tiene como
        // mínimo 2 líneas, superar el máximo en asientos GARANTIZA
        // superarlo también en filas reales, así que es seguro fallar
        // aquí sin recorrer el resto de páginas. El chequeo DEFINITIVO,
        // sobre el conteo real de filas, corre más abajo tras construir
        // `exportRows` — nunca se trunca en silencio si solo este
        // pre-chequeo pasara pero las líneas reales igual superaran el
        // máximo.
        this.excelExportService.assertWithinExportLimit(total, 'libro diario');

        const all: JournalEntryRow[] = firstRows.map(toJournalEntryRow);
        const totalPages =
          total === 0 ? 0 : Math.ceil(total / EXPORT_PAGE_SIZE);
        for (let page = 2; page <= totalPages; page++) {
          const { rows } = await this.fetchJournalPage(
            tx,
            where,
            (page - 1) * EXPORT_PAGE_SIZE,
            EXPORT_PAGE_SIZE,
          );
          all.push(...rows.map(toJournalEntryRow));
        }
        return all;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        // Exportaciones grandes (hasta MAX_EXPORT_ROWS) pueden recorrer
        // muchas páginas internas; se amplía el timeout por defecto de
        // Prisma (5s) para esta transacción de SOLO LECTURA específica,
        // nunca para getJournalReport() (una sola página, sin necesidad).
        maxWait: 10000,
        timeout: 30000,
      },
    );

    // Una fila de Excel por LÍNEA (no por asiento): un asiento con N líneas
    // produce N filas, cada una repitiendo la cabecera del asiento — así
    // el archivo permanece tabular y filtrable en Excel sin anidar.
    interface JournalExportRow {
      accountingDate: string;
      periodYear: number;
      periodMonth: number;
      journalNumber: number;
      entryId: string;
      description: string;
      sourceType: string;
      sourceId: string;
      eventType: string;
      accountCode: string;
      accountName: string;
      debitAmount: number;
      creditAmount: number;
      entryTotalDebit: number;
      entryTotalCredit: number;
    }
    const exportRows: JournalExportRow[] = [];
    for (const entry of entries) {
      for (const line of entry.lines) {
        exportRows.push({
          accountingDate: entry.accountingDate,
          periodYear: entry.periodYear,
          periodMonth: entry.periodMonth,
          journalNumber: entry.journalNumber,
          entryId: entry.id,
          description: entry.description,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          eventType: entry.eventType,
          accountCode: line.accountCode,
          accountName: line.accountName,
          debitAmount: Number(line.debitAmount),
          creditAmount: Number(line.creditAmount),
          entryTotalDebit: Number(entry.totalDebit),
          entryTotalCredit: Number(entry.totalCredit),
        });
      }
    }

    // Chequeo DEFINITIVO: el conteo REAL de filas que se escribirán en el
    // .xlsx (una por línea, nunca por asiento) — nunca se trunca en
    // silencio aunque el pre-chequeo rápido de arriba (sobre asientos) ya
    // hubiera pasado.
    this.excelExportService.assertWithinExportLimit(
      exportRows.length,
      'libro diario',
    );

    const columns: ExcelColumn<JournalExportRow>[] = [
      {
        key: 'accountingDate',
        header: 'Fecha contable',
        type: 'date',
        value: (r) => toPrismaDate(r.accountingDate),
      },
      {
        key: 'periodYear',
        header: 'Año periodo',
        type: 'number',
        value: (r) => r.periodYear,
        width: 10,
      },
      {
        key: 'periodMonth',
        header: 'Mes periodo',
        type: 'number',
        value: (r) => r.periodMonth,
        width: 10,
      },
      {
        key: 'journalNumber',
        header: 'N° asiento',
        type: 'number',
        value: (r) => r.journalNumber,
        width: 10,
      },
      {
        key: 'entryId',
        header: 'ID del asiento',
        type: 'identifier',
        value: (r) => r.entryId,
        width: 38,
      },
      {
        key: 'description',
        header: 'Descripción',
        type: 'string',
        value: (r) => r.description,
        width: 32,
      },
      {
        key: 'sourceType',
        header: 'Origen',
        type: 'string',
        value: (r) => r.sourceType,
      },
      {
        key: 'sourceId',
        header: 'ID origen',
        type: 'identifier',
        value: (r) => r.sourceId,
        width: 38,
      },
      {
        key: 'eventType',
        header: 'Tipo',
        type: 'string',
        value: (r) => r.eventType,
      },
      {
        key: 'accountCode',
        header: 'Código de cuenta',
        type: 'identifier',
        value: (r) => r.accountCode,
      },
      {
        key: 'accountName',
        header: 'Cuenta',
        type: 'string',
        value: (r) => r.accountName,
        width: 28,
      },
      {
        key: 'debitAmount',
        header: 'Debe',
        type: 'number',
        value: (r) => r.debitAmount,
      },
      {
        key: 'creditAmount',
        header: 'Haber',
        type: 'number',
        value: (r) => r.creditAmount,
      },
      {
        key: 'entryTotalDebit',
        header: 'Total debe (asiento)',
        type: 'number',
        value: (r) => r.entryTotalDebit,
      },
      {
        key: 'entryTotalCredit',
        header: 'Total haber (asiento)',
        type: 'number',
        value: (r) => r.entryTotalCredit,
      },
    ];

    return this.excelExportService.buildWorkbook(
      'Libro Diario',
      columns,
      exportRows,
    );
  }

  /**
   * Único punto de consulta de una página del Diario (A3.1), compartido
   * por `getJournalReport()` (su propia transacción de una página) y
   * `exportJournalXlsx()` (una sola transacción reutilizada en todo el
   * bucle de páginas) — nunca dos implementaciones independientes de la
   * misma consulta.
   */
  private async fetchJournalPage(
    client: Prisma.TransactionClient,
    where: Prisma.AccountingEntryWhereInput,
    skip: number,
    take: number,
  ): Promise<{ rows: JournalEntryQueryRow[]; total: number }> {
    const [rows, total] = await Promise.all([
      client.accountingEntry.findMany({
        where,
        select: JOURNAL_ENTRY_SELECT,
        orderBy: [
          { accountingDate: 'asc' },
          { journalNumber: 'asc' },
          { id: 'asc' },
        ],
        skip,
        take,
      }),
      client.accountingEntry.count({ where }),
    ]);
    return { rows, total };
  }

  private buildJournalWhere(
    query: JournalReportQuery,
  ): Prisma.AccountingEntryWhereInput {
    const where: Prisma.AccountingEntryWhereInput = {
      accountingDate: {
        gte: toPrismaDate(query.accountingDateFrom),
        lte: toPrismaDate(query.accountingDateTo),
      },
    };
    if (query.periodId !== undefined) {
      where.periodId = query.periodId;
    }
    return where;
  }

  // ==================================================================
  // A3.2 — Libro Mayor
  // ==================================================================

  async getLedgerReport(
    query: LedgerReportQuery,
    requesterRole: RoleName,
  ): Promise<LedgerReportResult> {
    assertCanReadReports(requesterRole);
    assertValidAccountingDateRange(
      query.accountingDateFrom,
      query.accountingDateTo,
    );

    // Revisión A3 (consistencia de lectura): apertura y movimientos del
    // periodo son dos consultas separadas; bajo la MISMA transacción
    // REPEATABLE READ ambas observan el mismo snapshot, así que un
    // asiento nuevo comprometido a mitad de la consulta nunca puede
    // aparecer en una mitad del cálculo (p. ej. en movimientos) sin la
    // otra (p. ej. reflejado consistentemente en el cierre).
    const full = await this.prisma.$transaction(
      (tx) => this.computeFullLedger(tx, query),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const page = normalizePage(query.page);
    const limit = normalizeLimit(query.limit);
    const total = full.movements.length;
    const skip = (page - 1) * limit;

    return {
      accountId: full.account.id,
      accountCode: full.account.code,
      accountName: full.account.name,
      accountType: full.account.type,
      accountStatus: full.account.status,
      normalBalance: full.account.normalBalance,
      accountingDateFrom: query.accountingDateFrom,
      accountingDateTo: query.accountingDateTo,
      openingBalance: full.openingBalance.toFixed(2),
      closingBalance: full.closingBalance.toFixed(2),
      data: full.movements.slice(skip, skip + limit),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /** A3.5: exporta el Mayor COMPLETO (apertura + todos los movimientos + cierre), nunca solo la página visible. */
  async exportLedgerXlsx(
    query: LedgerReportQuery,
    requesterRole: RoleName,
  ): Promise<Buffer> {
    assertCanReadReports(requesterRole);
    assertValidAccountingDateRange(
      query.accountingDateFrom,
      query.accountingDateTo,
    );

    const full = await this.prisma.$transaction(
      (tx) => this.computeFullLedger(tx, query),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    this.excelExportService.assertWithinExportLimit(
      full.movements.length + 2,
      'libro mayor',
    );

    interface LedgerExportRow {
      accountingDate: string | null;
      journalNumber: number | null;
      description: string;
      eventType: string | null;
      debitAmount: number | null;
      creditAmount: number | null;
      runningBalance: number;
      rowLabel: 'OPENING' | 'MOVEMENT' | 'CLOSING';
    }
    const exportRows: LedgerExportRow[] = [
      {
        accountingDate: null,
        journalNumber: null,
        description: `Saldo de apertura — ${full.account.code} ${full.account.name}`,
        eventType: null,
        debitAmount: null,
        creditAmount: null,
        runningBalance: Number(full.openingBalance.toFixed(2)),
        rowLabel: 'OPENING',
      },
      ...full.movements.map((m): LedgerExportRow => ({
        accountingDate: m.accountingDate,
        journalNumber: m.journalNumber,
        description: m.description,
        eventType: m.eventType,
        debitAmount: Number(m.debitAmount),
        creditAmount: Number(m.creditAmount),
        runningBalance: Number(m.runningBalance),
        rowLabel: 'MOVEMENT',
      })),
      {
        accountingDate: null,
        journalNumber: null,
        description: `Saldo de cierre — ${full.account.code} ${full.account.name}`,
        eventType: null,
        debitAmount: null,
        creditAmount: null,
        runningBalance: Number(full.closingBalance.toFixed(2)),
        rowLabel: 'CLOSING',
      },
    ];

    const columns: ExcelColumn<LedgerExportRow>[] = [
      {
        key: 'rowLabel',
        header: 'Tipo de fila',
        type: 'string',
        value: (r) => r.rowLabel,
        width: 14,
      },
      {
        key: 'accountingDate',
        header: 'Fecha contable',
        type: 'date',
        value: (r) =>
          r.accountingDate === null ? null : toPrismaDate(r.accountingDate),
      },
      {
        key: 'journalNumber',
        header: 'N° asiento',
        type: 'number',
        value: (r) => r.journalNumber,
        width: 10,
      },
      {
        key: 'description',
        header: 'Descripción',
        type: 'string',
        value: (r) => r.description,
        width: 36,
      },
      {
        key: 'eventType',
        header: 'Tipo',
        type: 'string',
        value: (r) => r.eventType ?? '',
      },
      {
        key: 'debitAmount',
        header: 'Debe',
        type: 'number',
        value: (r) => r.debitAmount,
      },
      {
        key: 'creditAmount',
        header: 'Haber',
        type: 'number',
        value: (r) => r.creditAmount,
      },
      {
        key: 'runningBalance',
        header: 'Saldo',
        type: 'number',
        value: (r) => r.runningBalance,
      },
    ];

    return this.excelExportService.buildWorkbook(
      `Mayor - ${full.account.code}`.slice(0, 31),
      columns,
      exportRows,
    );
  }

  /**
   * Único punto de cómputo del Mayor (A3.2), compartido por listado y
   * exportación — nunca recalculado dos veces de forma independiente, y
   * nunca en un bucle de páginas (el saldo acumulado exige la secuencia
   * COMPLETA una sola vez; paginar después de calcularla es gratis).
   * Acotado a UNA cuenta: cargar todos sus movimientos en memoria es
   * razonable (nunca "el historial completo de todas las cuentas").
   */
  private async computeFullLedger(
    client: Prisma.TransactionClient,
    query: LedgerReportQuery,
  ): Promise<FullLedgerComputation> {
    const accountRow = await client.account.findUnique({
      where: { id: query.accountId },
      select: { id: true, code: true, name: true, type: true, status: true },
    });
    if (accountRow === null) {
      throw new NotFoundException('Cuenta contable no encontrada');
    }
    const normalBalance = accountNormalBalance(accountRow.type);
    const account: LedgerAccountInfo = { ...accountRow, normalBalance };

    const fromDate = toPrismaDate(query.accountingDateFrom);
    const toDate = toPrismaDate(query.accountingDateTo);

    const openingAgg = await client.accountingEntryLine.aggregate({
      where: {
        accountId: query.accountId,
        entry: { accountingDate: { lt: fromDate } },
      },
      _sum: { debitAmount: true, creditAmount: true },
    });
    const openingBalance = signedNaturalBalance(
      normalBalance,
      openingAgg._sum.debitAmount ?? new Prisma.Decimal(0),
      openingAgg._sum.creditAmount ?? new Prisma.Decimal(0),
    );

    const periodLines = await client.accountingEntryLine.findMany({
      where: {
        accountId: query.accountId,
        entry: { accountingDate: { gte: fromDate, lte: toDate } },
      },
      select: LEDGER_LINE_SELECT,
      orderBy: [
        { entry: { accountingDate: 'asc' } },
        { entry: { journalNumber: 'asc' } },
        { id: 'asc' },
      ],
    });

    let running = openingBalance;
    const movements: LedgerMovementRow[] = periodLines.map((line) => {
      const delta = signedNaturalBalance(
        normalBalance,
        line.debitAmount,
        line.creditAmount,
      );
      running = running.plus(delta);
      return toLedgerMovementRow(line, running);
    });

    return {
      account,
      openingBalance,
      closingBalance: running,
      movements,
    };
  }

  // ==================================================================
  // A3.3 — Balance de comprobación
  // ==================================================================

  async getTrialBalanceReport(
    query: TrialBalanceQuery,
    requesterRole: RoleName,
  ): Promise<TrialBalanceReportResult> {
    assertCanReadReports(requesterRole);
    assertValidAccountingDateRange(
      query.accountingDateFrom,
      query.accountingDateTo,
    );
    if (query.accountIds !== undefined && query.accountIds.length === 0) {
      throw new BadRequestException(
        'accountIds no puede ser un arreglo vacío; omita el filtro para incluir todas las cuentas',
      );
    }

    const fromDate = toPrismaDate(query.accountingDateFrom);
    const toDate = toPrismaDate(query.accountingDateTo);
    const accountFilter: Prisma.AccountingEntryLineWhereInput =
      query.accountIds !== undefined
        ? { accountId: { in: query.accountIds } }
        : {};

    // Revisión A3 (consistencia de lectura): las 3 consultas (cuentas,
    // agregado de apertura, agregado del periodo) corren dentro de la
    // MISMA transacción REPEATABLE READ. Sin esto, cada una vería su
    // propio snapshot bajo READ COMMITTED (el `Promise.all` original las
    // disparaba como 3 transacciones implícitas independientes), con
    // riesgo real de que un asiento nuevo comprometido a mitad de camino
    // quedara reflejado en una agregación pero no en la otra — rompiendo
    // exactamente la identidad "cierre = apertura + movimiento del
    // periodo" y la reconciliación de totales que este reporte garantiza.
    const [accounts, openingGroups, periodGroups] =
      await this.prisma.$transaction(
        (tx) =>
          Promise.all([
            tx.account.findMany({
              where:
                query.accountIds !== undefined
                  ? { id: { in: query.accountIds } }
                  : {},
              select: {
                id: true,
                code: true,
                name: true,
                type: true,
                status: true,
              },
              orderBy: [{ code: 'asc' }],
            }),
            tx.accountingEntryLine.groupBy({
              by: ['accountId'],
              where: {
                ...accountFilter,
                entry: { accountingDate: { lt: fromDate } },
              },
              _sum: { debitAmount: true, creditAmount: true },
            }),
            tx.accountingEntryLine.groupBy({
              by: ['accountId'],
              where: {
                ...accountFilter,
                entry: { accountingDate: { gte: fromDate, lte: toDate } },
              },
              _sum: { debitAmount: true, creditAmount: true },
            }),
          ]),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );

    const openingByAccount = new Map(
      openingGroups.map((g) => [
        g.accountId,
        {
          debit: g._sum.debitAmount ?? new Prisma.Decimal(0),
          credit: g._sum.creditAmount ?? new Prisma.Decimal(0),
        },
      ]),
    );
    const periodByAccount = new Map(
      periodGroups.map((g) => [
        g.accountId,
        {
          debit: g._sum.debitAmount ?? new Prisma.Decimal(0),
          credit: g._sum.creditAmount ?? new Prisma.Decimal(0),
        },
      ]),
    );

    const includeZero = query.includeZeroBalances ?? false;
    const zero = new Prisma.Decimal(0);
    const rows: TrialBalanceAccountRow[] = [];

    const totals = {
      openingDebit: new Prisma.Decimal(0),
      openingCredit: new Prisma.Decimal(0),
      periodDebit: new Prisma.Decimal(0),
      periodCredit: new Prisma.Decimal(0),
      endingDebit: new Prisma.Decimal(0),
      endingCredit: new Prisma.Decimal(0),
    };

    for (const account of accounts) {
      const opening = openingByAccount.get(account.id) ?? {
        debit: zero,
        credit: zero,
      };
      const period = periodByAccount.get(account.id) ?? {
        debit: zero,
        credit: zero,
      };

      const openingSplit = splitNetBalance(opening.debit, opening.credit);
      const endingNetDebit = opening.debit.plus(period.debit);
      const endingNetCredit = opening.credit.plus(period.credit);
      const endingSplit = splitNetBalance(endingNetDebit, endingNetCredit);

      const hasRelevantAmount =
        !openingSplit.debit.isZero() ||
        !openingSplit.credit.isZero() ||
        !period.debit.isZero() ||
        !period.credit.isZero() ||
        !endingSplit.debit.isZero() ||
        !endingSplit.credit.isZero();

      if (
        !includeZero &&
        query.accountIds === undefined &&
        !hasRelevantAmount
      ) {
        continue;
      }

      rows.push({
        accountId: account.id,
        accountCode: account.code,
        accountName: account.name,
        accountType: account.type,
        accountStatus: account.status,
        openingDebit: openingSplit.debit.toFixed(2),
        openingCredit: openingSplit.credit.toFixed(2),
        periodDebit: period.debit.toFixed(2),
        periodCredit: period.credit.toFixed(2),
        endingDebit: endingSplit.debit.toFixed(2),
        endingCredit: endingSplit.credit.toFixed(2),
      });

      totals.openingDebit = totals.openingDebit.plus(openingSplit.debit);
      totals.openingCredit = totals.openingCredit.plus(openingSplit.credit);
      totals.periodDebit = totals.periodDebit.plus(period.debit);
      totals.periodCredit = totals.periodCredit.plus(period.credit);
      totals.endingDebit = totals.endingDebit.plus(endingSplit.debit);
      totals.endingCredit = totals.endingCredit.plus(endingSplit.credit);
    }

    const applicable = query.accountIds === undefined;

    return {
      accountingDateFrom: query.accountingDateFrom,
      accountingDateTo: query.accountingDateTo,
      data: rows,
      reconciliation: {
        applicable,
        openingBalanced: applicable
          ? totals.openingDebit.equals(totals.openingCredit)
          : null,
        periodBalanced: applicable
          ? totals.periodDebit.equals(totals.periodCredit)
          : null,
        endingBalanced: applicable
          ? totals.endingDebit.equals(totals.endingCredit)
          : null,
        totalOpeningDebit: totals.openingDebit.toFixed(2),
        totalOpeningCredit: totals.openingCredit.toFixed(2),
        totalPeriodDebit: totals.periodDebit.toFixed(2),
        totalPeriodCredit: totals.periodCredit.toFixed(2),
        totalEndingDebit: totals.endingDebit.toFixed(2),
        totalEndingCredit: totals.endingCredit.toFixed(2),
      },
    };
  }

  /** A3.5: el balance de comprobación nunca se pagina (A3.3 exige el conjunto completo para reconciliar), así que la exportación reutiliza exactamente el mismo cálculo sin ningún bucle de páginas. */
  async exportTrialBalanceXlsx(
    query: TrialBalanceQuery,
    requesterRole: RoleName,
  ): Promise<Buffer> {
    const report = await this.getTrialBalanceReport(query, requesterRole);
    this.excelExportService.assertWithinExportLimit(
      report.data.length,
      'balance de comprobación',
    );

    const columns: ExcelColumn<TrialBalanceAccountRow>[] = [
      {
        key: 'accountCode',
        header: 'Código',
        type: 'identifier',
        value: (r) => r.accountCode,
      },
      {
        key: 'accountName',
        header: 'Cuenta',
        type: 'string',
        value: (r) => r.accountName,
        width: 30,
      },
      {
        key: 'accountType',
        header: 'Clasificación',
        type: 'string',
        value: (r) => r.accountType,
      },
      {
        key: 'accountStatus',
        header: 'Estado',
        type: 'string',
        value: (r) => r.accountStatus,
      },
      {
        key: 'openingDebit',
        header: 'Apertura debe',
        type: 'number',
        value: (r) => Number(r.openingDebit),
      },
      {
        key: 'openingCredit',
        header: 'Apertura haber',
        type: 'number',
        value: (r) => Number(r.openingCredit),
      },
      {
        key: 'periodDebit',
        header: 'Movimiento debe',
        type: 'number',
        value: (r) => Number(r.periodDebit),
      },
      {
        key: 'periodCredit',
        header: 'Movimiento haber',
        type: 'number',
        value: (r) => Number(r.periodCredit),
      },
      {
        key: 'endingDebit',
        header: 'Cierre debe',
        type: 'number',
        value: (r) => Number(r.endingDebit),
      },
      {
        key: 'endingCredit',
        header: 'Cierre haber',
        type: 'number',
        value: (r) => Number(r.endingCredit),
      },
    ];

    return this.excelExportService.buildWorkbook(
      'Balance de Comprobacion',
      columns,
      report.data,
    );
  }
}

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountingSourceType,
  Prisma,
  PurchaseInvoiceStatus,
  RoleName,
  SupplierPaymentStatus,
} from '@prisma/client';
import {
  AgingBucket,
  calculatePercentage,
  computeAgingBucket,
} from './accounts-payable-calculator';
import {
  businessToday,
  fromPrismaDate,
  isValidDateOnly,
  toPrismaDate,
} from '../common/date/business-date';
import { ExcelColumn } from '../common/excel/excel-column';
import { EXPORT_PAGE_SIZE } from '../common/excel/excel-export.constants';
import { ExcelExportService } from '../common/excel/excel-export.service';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import { computeAccountsPayableStatus } from './supplier-payment-calculator';
import { AgingBySupplier, AgingReport } from './types/accounts-payable-aging';
import { AccountsPayableFilterQuery } from './types/accounts-payable-filter.query';
import {
  AccountsPayableDetail,
  AccountsPayableItem,
  AccountsPayablePaymentHistoryItem,
} from './types/accounts-payable-item';
import {
  ApAccountReconciliationRow,
  ApInvoiceReconciliationRow,
  ApReconciliationReport,
} from './types/accounts-payable-reconciliation';
import {
  AccountsPayableSummaryReport,
  AccountsPayableSupplierSummary,
} from './types/accounts-payable-summary';
import { ListAccountsPayableQuery } from './types/list-accounts-payable.query';

const ZERO = new Prisma.Decimal(0);
const REPEATABLE_READ = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
};

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Limitación estructural del reporte de antigüedad y de la conciliación
 * (Fase A5.4): ambos reflejan el saldo VIGENTE, nunca un saldo histórico
 * reconstruido a una fecha de corte pasada — el historial de pagos/
 * anulaciones de A5.3 no incluye todo lo necesario para esa
 * reconstrucción fiel (p. ej., el saldo "al 31 de enero" de una factura
 * que luego recibió un pago el 5 de febrero y se anuló el 10 de marzo
 * requiere separar qué estaba vigente exactamente en cada instante).
 * Documentado explícitamente en vez de inventar un saldo histórico.
 */
const CURRENT_BALANCE_ONLY_LIMITATION =
  'Este reporte refleja el saldo pendiente VIGENTE a la fecha de generación — no reconstruye saldos históricos a una fecha de corte pasada.';

/** ADMIN/MANAGEMENT/ACCOUNTANT leen; SELLER/WAREHOUSE sin ningún acceso (A5.3/A5.4, mismo criterio que el resto del dominio contable/compras). */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
]);

function assertCanRead(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar cuentas por pagar',
    );
  }
}

const AP_INVOICE_SELECT = {
  id: true,
  supplierId: true,
  documentType: true,
  documentSeries: true,
  documentNumber: true,
  issueDate: true,
  dueDate: true,
  currencyCode: true,
  totalAmount: true,
  postedEntryId: true,
  supplier: { select: { legalName: true, documentNumber: true } },
} satisfies Prisma.PurchaseInvoiceSelect;

type ApInvoiceRow = Prisma.PurchaseInvoiceGetPayload<{
  select: typeof AP_INVOICE_SELECT;
}>;

/** Fila ya computada (Decimal, nunca string) — base común de list()/getSummary()/getAging(). */
interface ApComputedRow {
  row: ApInvoiceRow;
  paidAmount: Prisma.Decimal;
  balanceDue: Prisma.Decimal;
  status: ReturnType<typeof computeAccountsPayableStatus>;
  agingBucket: AgingBucket;
  daysOverdue: number | null;
}

function toAccountsPayableItem(computed: ApComputedRow): AccountsPayableItem {
  const { row } = computed;
  return {
    purchaseInvoiceId: row.id,
    supplierId: row.supplierId,
    supplierLegalName: row.supplier.legalName,
    supplierDocumentNumber: row.supplier.documentNumber,
    documentType: row.documentType,
    documentSeries: row.documentSeries,
    documentNumber: row.documentNumber,
    issueDate: fromPrismaDate(row.issueDate),
    dueDate: row.dueDate !== null ? fromPrismaDate(row.dueDate) : null,
    currencyCode: row.currencyCode,
    originalAmount: row.totalAmount.toFixed(2),
    paidAmount: computed.paidAmount.toFixed(2),
    balanceDue: computed.balanceDue.toFixed(2),
    status: computed.status,
    agingBucket: computed.agingBucket,
    daysOverdue: computed.daysOverdue,
  };
}

/**
 * Cuentas por pagar (Fase A5.3) y sus reportes (Fase A5.4): solo lectura.
 * Una cuenta por pagar es siempre una PurchaseInvoice CONFIRMED — nunca
 * nace de una recepción física (A5.2b es independiente). paidAmount/
 * balanceDue/status se calculan SIEMPRE en tiempo de lectura a partir de
 * SupplierPaymentAllocation ACTIVE — nunca una columna duplicada que
 * pudiera desincronizarse. Cada reporte que combina varias consultas
 * corre dentro de una única transacción REPEATABLE READ (mismo criterio
 * que AccountingReportsService, A3-review): así ningún pago/factura
 * comprometido a mitad de camino puede dejar un reporte con una mitad de
 * un snapshot y la otra mitad de otro.
 */
@Injectable()
export class AccountsPayableService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly excelExportService: ExcelExportService,
  ) {}

  // ==================================================================
  // Listado general (Fase A5.3, filtros/aging extendidos en A5.4)
  // ==================================================================

  async list(
    query: ListAccountsPayableQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<AccountsPayableItem>> {
    assertCanRead(requesterRole);
    this.assertValidFilterQuery(query);

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

    const computed = await this.prisma.$transaction(
      (tx) => this.computeRows(tx, query),
      REPEATABLE_READ,
    );

    let filtered = computed;
    if (query.agingBucket !== undefined) {
      filtered = filtered.filter((r) => r.agingBucket === query.agingBucket);
    }

    const total = filtered.length;
    const skip = (page - 1) * limit;
    const data = filtered.slice(skip, skip + limit).map(toAccountsPayableItem);

    return {
      data,
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /** Detalle de una cuenta por pagar + historial completo de aplicación de pagos (ACTIVE y CANCELLED). */
  async getDetail(
    purchaseInvoiceId: string,
    requesterRole: RoleName,
  ): Promise<AccountsPayableDetail> {
    assertCanRead(requesterRole);

    // REPEATABLE READ (mismo criterio que list()/getSummary()/...): la
    // factura, su saldo pagado y su historial de pagos se leen del MISMO
    // snapshot — nunca una mitad reflejando un pago comprometido a mitad
    // de camino y la otra mitad no.
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.purchaseInvoice.findUnique({
        where: { id: purchaseInvoiceId },
        select: { ...AP_INVOICE_SELECT, status: true },
      });
      // Una factura DRAFT/CANCELLED nunca es una cuenta por pagar (A5.3):
      // se trata igual que inexistente, mismo criterio 404 que el resto
      // del dominio ante un recurso fuera de alcance.
      if (row === null || row.status !== PurchaseInvoiceStatus.CONFIRMED) {
        throw new NotFoundException('Cuenta por pagar no encontrada');
      }

      const paidMap = await this.computePaidAmounts(tx, [row.id]);
      const computed = this.toComputedRow(
        row,
        paidMap.get(row.id) ?? ZERO,
        businessToday(),
      );

      const allocations = await tx.supplierPaymentAllocation.findMany({
        where: { purchaseInvoiceId: row.id },
        select: {
          amount: true,
          createdAt: true,
          supplierPayment: {
            select: {
              id: true,
              status: true,
              paymentDate: true,
              paymentMethodCode: true,
              reference: true,
            },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      const payments: AccountsPayablePaymentHistoryItem[] = allocations.map(
        (allocation) => ({
          supplierPaymentId: allocation.supplierPayment.id,
          status: allocation.supplierPayment.status,
          paymentDate: fromPrismaDate(allocation.supplierPayment.paymentDate),
          amountApplied: allocation.amount.toFixed(2),
          paymentMethodCode: allocation.supplierPayment.paymentMethodCode,
          reference: allocation.supplierPayment.reference,
        }),
      );

      return { ...toAccountsPayableItem(computed), payments };
    }, REPEATABLE_READ);
  }

  // ==================================================================
  // Resumen por proveedor (Fase A5.4)
  // ==================================================================

  async getSummary(
    query: AccountsPayableFilterQuery,
    requesterRole: RoleName,
  ): Promise<AccountsPayableSummaryReport> {
    assertCanRead(requesterRole);
    this.assertValidFilterQuery(query);

    const computed = await this.prisma.$transaction(
      (tx) => this.computeRows(tx, query),
      REPEATABLE_READ,
    );

    const bySupplierMap = new Map<
      string,
      {
        supplierLegalName: string;
        supplierDocumentNumber: string;
        invoiceCount: number;
        totalOriginal: Prisma.Decimal;
        totalPaid: Prisma.Decimal;
      }
    >();
    for (const c of computed) {
      const key = c.row.supplierId;
      const existing = bySupplierMap.get(key);
      if (existing === undefined) {
        bySupplierMap.set(key, {
          supplierLegalName: c.row.supplier.legalName,
          supplierDocumentNumber: c.row.supplier.documentNumber,
          invoiceCount: 1,
          totalOriginal: c.row.totalAmount,
          totalPaid: c.paidAmount,
        });
      } else {
        existing.invoiceCount += 1;
        existing.totalOriginal = existing.totalOriginal.plus(c.row.totalAmount);
        existing.totalPaid = existing.totalPaid.plus(c.paidAmount);
      }
    }

    const bySupplier: AccountsPayableSupplierSummary[] = Array.from(
      bySupplierMap.entries(),
    )
      .map(([supplierId, v]) => ({
        supplierId,
        supplierLegalName: v.supplierLegalName,
        supplierDocumentNumber: v.supplierDocumentNumber,
        invoiceCount: v.invoiceCount,
        totalOriginal: v.totalOriginal.toFixed(2),
        totalPaid: v.totalPaid.toFixed(2),
        totalPending: v.totalOriginal.minus(v.totalPaid).toFixed(2),
      }))
      .sort((a, b) => a.supplierLegalName.localeCompare(b.supplierLegalName));

    const grandTotalOriginal = computed.reduce(
      (sum, c) => sum.plus(c.row.totalAmount),
      ZERO,
    );
    const grandTotalPaid = computed.reduce(
      (sum, c) => sum.plus(c.paidAmount),
      ZERO,
    );

    return {
      bySupplier,
      grandTotal: {
        invoiceCount: computed.length,
        totalOriginal: grandTotalOriginal.toFixed(2),
        totalPaid: grandTotalPaid.toFixed(2),
        totalPending: grandTotalOriginal.minus(grandTotalPaid).toFixed(2),
      },
    };
  }

  // ==================================================================
  // Antigüedad de deuda / aging (Fase A5.4)
  // ==================================================================

  async getAging(
    query: AccountsPayableFilterQuery,
    requesterRole: RoleName,
  ): Promise<AgingReport> {
    assertCanRead(requesterRole);
    this.assertValidFilterQuery(query);

    const asOfDate = businessToday();
    const computed = await this.prisma.$transaction(
      (tx) => this.computeRows(tx, query, asOfDate),
      REPEATABLE_READ,
    );

    const bySupplierMap = new Map<
      string,
      {
        supplierLegalName: string;
        supplierDocumentNumber: string;
        totalPending: Prisma.Decimal;
        buckets: Map<AgingBucket, { count: number; amount: Prisma.Decimal }>;
      }
    >();
    const overallBuckets = new Map<
      AgingBucket,
      { count: number; amount: Prisma.Decimal }
    >();
    let overallTotalPending = ZERO;

    for (const c of computed) {
      overallTotalPending = overallTotalPending.plus(c.balanceDue);
      const overallBucket = overallBuckets.get(c.agingBucket) ?? {
        count: 0,
        amount: ZERO,
      };
      overallBucket.count += 1;
      overallBucket.amount = overallBucket.amount.plus(c.balanceDue);
      overallBuckets.set(c.agingBucket, overallBucket);

      const supplierId = c.row.supplierId;
      const supplierEntry = bySupplierMap.get(supplierId) ?? {
        supplierLegalName: c.row.supplier.legalName,
        supplierDocumentNumber: c.row.supplier.documentNumber,
        totalPending: ZERO,
        buckets: new Map<
          AgingBucket,
          { count: number; amount: Prisma.Decimal }
        >(),
      };
      supplierEntry.totalPending = supplierEntry.totalPending.plus(
        c.balanceDue,
      );
      const supplierBucket = supplierEntry.buckets.get(c.agingBucket) ?? {
        count: 0,
        amount: ZERO,
      };
      supplierBucket.count += 1;
      supplierBucket.amount = supplierBucket.amount.plus(c.balanceDue);
      supplierEntry.buckets.set(c.agingBucket, supplierBucket);
      bySupplierMap.set(supplierId, supplierEntry);
    }

    const bySupplier: AgingBySupplier[] = Array.from(bySupplierMap.entries())
      .map(([supplierId, v]) => ({
        supplierId,
        supplierLegalName: v.supplierLegalName,
        supplierDocumentNumber: v.supplierDocumentNumber,
        totalPending: v.totalPending.toFixed(2),
        buckets: Array.from(v.buckets.entries()).map(([bucket, b]) => ({
          bucket,
          invoiceCount: b.count,
          amount: b.amount.toFixed(2),
          percentage: calculatePercentage(b.amount, v.totalPending),
        })),
      }))
      .sort((a, b) => a.supplierLegalName.localeCompare(b.supplierLegalName));

    return {
      asOfDate,
      totals: {
        totalPending: overallTotalPending.toFixed(2),
        buckets: Array.from(overallBuckets.entries()).map(([bucket, b]) => ({
          bucket,
          invoiceCount: b.count,
          amount: b.amount.toFixed(2),
          percentage: calculatePercentage(b.amount, overallTotalPending),
        })),
      },
      bySupplier,
      limitations: [CURRENT_BALANCE_ONLY_LIMITATION],
    };
  }

  // ==================================================================
  // Conciliación (Fase A5.4, SOLO LECTURA)
  // ==================================================================

  /**
   * Compara dos fuentes YA EXISTENTES, independientes entre sí — nunca
   * inventa una tercera ni corrige nada: (1) el saldo OPERATIVO de A5.3
   * (SupplierPaymentAllocation ACTIVE) y (2) lo REALMENTE posteado por
   * AccountingEngine, agrupado por la cuenta de pasivo HISTÓRICA de cada
   * factura (la que su propio asiento PURCHASE original acreditó — nunca
   * el mapeo VIGENTE de ACCOUNTS_PAYABLE, que pudo reasignarse desde
   * entonces). Nivel de cuenta usado en vez de nivel de pago individual
   * porque un mismo SupplierPayment puede cubrir varias facturas que
   * comparten cuenta histórica, agrupadas en una sola línea de débito —
   * desagregarlo por factura individual requeriría inventar un criterio
   * de reparto que esta conciliación no debe asumir.
   */
  async getReconciliation(
    query: AccountsPayableFilterQuery,
    requesterRole: RoleName,
  ): Promise<ApReconciliationReport> {
    assertCanRead(requesterRole);
    this.assertValidFilterQuery(query);

    return this.prisma.$transaction(async (tx) => {
      const computed = await this.computeRows(tx, query);

      const postedEntryIds = computed
        .map((c) => c.row.postedEntryId)
        .filter((id): id is string => id !== null);
      const creditLines =
        postedEntryIds.length > 0
          ? await tx.accountingEntryLine.findMany({
              where: {
                entryId: { in: postedEntryIds },
                creditAmount: { gt: 0 },
              },
              select: { entryId: true, accountId: true, creditAmount: true },
            })
          : [];
      const creditLinesByEntryId = new Map<
        string,
        { accountId: string; creditAmount: Prisma.Decimal }[]
      >();
      for (const line of creditLines) {
        const existing = creditLinesByEntryId.get(line.entryId) ?? [];
        existing.push({
          accountId: line.accountId,
          creditAmount: line.creditAmount,
        });
        creditLinesByEntryId.set(line.entryId, existing);
      }

      const invoiceRows: ApInvoiceReconciliationRow[] = [];
      const operationalPaidByAccount = new Map<string, Prisma.Decimal>();
      const accountIdsInvolved = new Set<string>();

      for (const c of computed) {
        const discrepancies: ApInvoiceReconciliationRow['discrepancies'] = [];
        let historicalLiabilityAccountId: string | null = null;
        let creditedAmount: Prisma.Decimal | null = null;

        if (c.row.postedEntryId === null) {
          discrepancies.push('MISSING_ORIGINAL_ENTRY');
        } else {
          const lines = creditLinesByEntryId.get(c.row.postedEntryId) ?? [];
          if (lines.length !== 1) {
            discrepancies.push('INVALID_CREDIT_LINE_COUNT');
          } else {
            historicalLiabilityAccountId = lines[0].accountId;
            creditedAmount = lines[0].creditAmount;
            if (!creditedAmount.equals(c.row.totalAmount)) {
              discrepancies.push('CREDIT_AMOUNT_MISMATCH');
            }
          }
        }

        if (historicalLiabilityAccountId !== null) {
          accountIdsInvolved.add(historicalLiabilityAccountId);
          operationalPaidByAccount.set(
            historicalLiabilityAccountId,
            (
              operationalPaidByAccount.get(historicalLiabilityAccountId) ?? ZERO
            ).plus(c.paidAmount),
          );
        }

        invoiceRows.push({
          purchaseInvoiceId: c.row.id,
          supplierId: c.row.supplierId,
          originalAmount: c.row.totalAmount.toFixed(2),
          postedEntryId: c.row.postedEntryId,
          historicalLiabilityAccountId,
          creditedAmount:
            creditedAmount !== null ? creditedAmount.toFixed(2) : null,
          operationalPaidAmount: c.paidAmount.toFixed(2),
          operationalPendingBalance: c.balanceDue.toFixed(2),
          discrepancies,
        });
      }

      const accountRows: ApAccountReconciliationRow[] = [];
      if (accountIdsInvolved.size > 0) {
        const accountIds = Array.from(accountIdsInvolved);
        const [accounts, netLines] = await Promise.all([
          tx.account.findMany({
            where: { id: { in: accountIds } },
            select: { id: true, code: true, name: true },
          }),
          tx.accountingEntryLine.groupBy({
            by: ['accountId'],
            where: {
              accountId: { in: accountIds },
              entry: { sourceType: AccountingSourceType.SUPPLIER_PAYMENT },
            },
            _sum: { debitAmount: true, creditAmount: true },
          }),
        ]);
        const accountById = new Map(accounts.map((a) => [a.id, a]));
        const netByAccountId = new Map(
          netLines.map((l) => [
            l.accountId,
            (l._sum.debitAmount ?? ZERO).minus(l._sum.creditAmount ?? ZERO),
          ]),
        );

        for (const accountId of accountIds) {
          const account = accountById.get(accountId);
          const operational = operationalPaidByAccount.get(accountId) ?? ZERO;
          const accountingNet = netByAccountId.get(accountId) ?? ZERO;
          const difference = operational.minus(accountingNet);
          accountRows.push({
            accountId,
            accountCode: account?.code ?? '(desconocida)',
            accountName: account?.name ?? '(desconocida)',
            operationalPaidAmount: operational.toFixed(2),
            accountingNetDebitAmount: accountingNet.toFixed(2),
            difference: difference.toFixed(2),
            discrepancies: difference.equals(0)
              ? []
              : ['ACCOUNT_BALANCE_MISMATCH'],
          });
        }
        accountRows.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
      }

      const overallConsistent =
        invoiceRows.every((r) => r.discrepancies.length === 0) &&
        accountRows.every((r) => r.discrepancies.length === 0);

      return {
        generatedAt: new Date().toISOString(),
        invoices: invoiceRows,
        accounts: accountRows,
        overallConsistent,
        limitations: [
          'La conciliación agrupa por cuenta de pasivo histórica, nunca por la asignación individual de un pago: un mismo pago puede cubrir varias facturas que comparten cuenta, agrupadas en una sola línea de débito.',
          'No evalúa políticas tributarias ni mapeos contables todavía no aprobados por el contador; solo compara fuentes ya existentes.',
        ],
      };
    }, REPEATABLE_READ);
  }

  // ==================================================================
  // Exportación a Excel (Fase A5.4)
  // ==================================================================

  async exportDetailedXlsx(
    query: ListAccountsPayableQuery,
    requesterRole: RoleName,
  ): Promise<Buffer> {
    assertCanRead(requesterRole);
    this.assertValidFilterQuery(query);

    const firstPage = await this.list(
      { ...query, page: 1, limit: EXPORT_PAGE_SIZE },
      requesterRole,
    );
    this.excelExportService.assertWithinExportLimit(
      firstPage.total,
      'cuentas por pagar',
    );
    const rows: AccountsPayableItem[] = [...firstPage.data];
    for (let page = 2; page <= firstPage.totalPages; page++) {
      const next = await this.list(
        { ...query, page, limit: EXPORT_PAGE_SIZE },
        requesterRole,
      );
      rows.push(...next.data);
    }

    const columns: ExcelColumn<AccountsPayableItem>[] = [
      {
        key: 'supplierLegalName',
        header: 'Proveedor',
        type: 'string',
        value: (r) => r.supplierLegalName,
      },
      {
        key: 'supplierDocumentNumber',
        header: 'Documento del proveedor',
        type: 'identifier',
        value: (r) => r.supplierDocumentNumber,
      },
      {
        key: 'documentNumber',
        header: 'Número de documento',
        type: 'identifier',
        value: (r) =>
          r.documentSeries
            ? `${r.documentSeries}-${r.documentNumber}`
            : r.documentNumber,
      },
      {
        key: 'issueDate',
        header: 'Fecha de emisión',
        type: 'date',
        value: (r) => toPrismaDate(r.issueDate),
      },
      {
        key: 'dueDate',
        header: 'Fecha de vencimiento',
        type: 'date',
        value: (r) => (r.dueDate !== null ? toPrismaDate(r.dueDate) : null),
      },
      {
        key: 'currencyCode',
        header: 'Moneda',
        type: 'string',
        value: (r) => r.currencyCode,
      },
      {
        key: 'originalAmount',
        header: 'Importe original',
        type: 'number',
        value: (r) => Number(r.originalAmount),
      },
      {
        key: 'paidAmount',
        header: 'Pagado',
        type: 'number',
        value: (r) => Number(r.paidAmount),
      },
      {
        key: 'balanceDue',
        header: 'Saldo pendiente',
        type: 'number',
        value: (r) => Number(r.balanceDue),
      },
      {
        key: 'status',
        header: 'Estado',
        type: 'string',
        value: (r) => r.status,
      },
      {
        key: 'agingBucket',
        header: 'Antigüedad',
        type: 'string',
        value: (r) => r.agingBucket,
      },
      {
        key: 'daysOverdue',
        header: 'Días vencidos',
        type: 'number',
        value: (r) => r.daysOverdue,
      },
    ];

    return this.excelExportService.buildWorkbook(
      'Cuentas por pagar',
      columns,
      rows,
    );
  }

  async exportSummaryXlsx(
    query: AccountsPayableFilterQuery,
    requesterRole: RoleName,
  ): Promise<Buffer> {
    const report = await this.getSummary(query, requesterRole);
    this.excelExportService.assertWithinExportLimit(
      report.bySupplier.length,
      'resumen de cuentas por pagar',
    );

    const columns: ExcelColumn<AccountsPayableSupplierSummary>[] = [
      {
        key: 'supplierLegalName',
        header: 'Proveedor',
        type: 'string',
        value: (r) => r.supplierLegalName,
      },
      {
        key: 'supplierDocumentNumber',
        header: 'Documento del proveedor',
        type: 'identifier',
        value: (r) => r.supplierDocumentNumber,
      },
      {
        key: 'invoiceCount',
        header: 'N° de facturas',
        type: 'number',
        value: (r) => r.invoiceCount,
      },
      {
        key: 'totalOriginal',
        header: 'Importe original',
        type: 'number',
        value: (r) => Number(r.totalOriginal),
      },
      {
        key: 'totalPaid',
        header: 'Pagado',
        type: 'number',
        value: (r) => Number(r.totalPaid),
      },
      {
        key: 'totalPending',
        header: 'Saldo pendiente',
        type: 'number',
        value: (r) => Number(r.totalPending),
      },
    ];

    return this.excelExportService.buildWorkbook(
      'Resumen por proveedor',
      columns,
      report.bySupplier,
    );
  }

  async exportAgingXlsx(
    query: AccountsPayableFilterQuery,
    requesterRole: RoleName,
  ): Promise<Buffer> {
    const report = await this.getAging(query, requesterRole);

    interface AgingExportRow {
      supplierLegalName: string;
      supplierDocumentNumber: string;
      bucket: string;
      invoiceCount: number;
      amount: string;
      percentage: string;
    }
    const exportRows: AgingExportRow[] = report.bySupplier.flatMap((s) =>
      s.buckets.map((b) => ({
        supplierLegalName: s.supplierLegalName,
        supplierDocumentNumber: s.supplierDocumentNumber,
        bucket: b.bucket,
        invoiceCount: b.invoiceCount,
        amount: b.amount,
        percentage: b.percentage,
      })),
    );
    this.excelExportService.assertWithinExportLimit(
      exportRows.length,
      'antigüedad de deuda',
    );

    const columns: ExcelColumn<AgingExportRow>[] = [
      {
        key: 'supplierLegalName',
        header: 'Proveedor',
        type: 'string',
        value: (r) => r.supplierLegalName,
      },
      {
        key: 'supplierDocumentNumber',
        header: 'Documento del proveedor',
        type: 'identifier',
        value: (r) => r.supplierDocumentNumber,
      },
      {
        key: 'bucket',
        header: 'Categoría de antigüedad',
        type: 'string',
        value: (r) => r.bucket,
      },
      {
        key: 'invoiceCount',
        header: 'N° de facturas',
        type: 'number',
        value: (r) => r.invoiceCount,
      },
      {
        key: 'amount',
        header: 'Importe',
        type: 'number',
        value: (r) => Number(r.amount),
      },
      {
        key: 'percentage',
        header: '% del proveedor',
        type: 'number',
        value: (r) => Number(r.percentage),
      },
    ];

    return this.excelExportService.buildWorkbook(
      'Antigüedad de deuda',
      columns,
      exportRows,
    );
  }

  async exportReconciliationXlsx(
    query: AccountsPayableFilterQuery,
    requesterRole: RoleName,
  ): Promise<Buffer> {
    const report = await this.getReconciliation(query, requesterRole);
    this.excelExportService.assertWithinExportLimit(
      report.invoices.length,
      'conciliación de cuentas por pagar',
    );

    const columns: ExcelColumn<ApInvoiceReconciliationRow>[] = [
      {
        key: 'purchaseInvoiceId',
        header: 'Factura',
        type: 'identifier',
        value: (r) => r.purchaseInvoiceId,
      },
      {
        key: 'originalAmount',
        header: 'Importe original',
        type: 'number',
        value: (r) => Number(r.originalAmount),
      },
      {
        key: 'creditedAmount',
        header: 'Acreditado en el asiento original',
        type: 'number',
        value: (r) =>
          r.creditedAmount !== null ? Number(r.creditedAmount) : null,
      },
      {
        key: 'operationalPaidAmount',
        header: 'Pagado (operativo)',
        type: 'number',
        value: (r) => Number(r.operationalPaidAmount),
      },
      {
        key: 'operationalPendingBalance',
        header: 'Saldo pendiente',
        type: 'number',
        value: (r) => Number(r.operationalPendingBalance),
      },
      {
        key: 'discrepancies',
        header: 'Discrepancias',
        type: 'string',
        value: (r) =>
          r.discrepancies.length > 0 ? r.discrepancies.join(', ') : 'NINGUNA',
      },
    ];

    return this.excelExportService.buildWorkbook(
      'Conciliación CxP',
      columns,
      report.invoices,
    );
  }

  // ==================================================================
  // Helpers privados
  // ==================================================================

  private buildWhere(
    query: AccountsPayableFilterQuery,
  ): Prisma.PurchaseInvoiceWhereInput {
    const where: Prisma.PurchaseInvoiceWhereInput = {
      status: PurchaseInvoiceStatus.CONFIRMED,
    };
    if (query.supplierId !== undefined) {
      where.supplierId = query.supplierId;
    }
    if (query.issueDateFrom !== undefined || query.issueDateTo !== undefined) {
      where.issueDate = {};
      if (query.issueDateFrom !== undefined) {
        where.issueDate.gte = toPrismaDate(query.issueDateFrom);
      }
      if (query.issueDateTo !== undefined) {
        where.issueDate.lte = toPrismaDate(query.issueDateTo);
      }
    }
    return where;
  }

  /**
   * Base compartida por list()/getSummary()/getAging(): una sola consulta
   * de facturas CONFIRMED (filtradas por supplier/fechas) + una sola
   * agregación de pagos ACTIVE, ambas computadas aquí una única vez.
   * `status` se filtra en memoria (es un valor DERIVADO, nunca una
   * columna indexable).
   */
  private async computeRows(
    tx: Prisma.TransactionClient,
    query: AccountsPayableFilterQuery,
    today: string = businessToday(),
  ): Promise<ApComputedRow[]> {
    const where = this.buildWhere(query);
    const rows = await tx.purchaseInvoice.findMany({
      where,
      select: AP_INVOICE_SELECT,
      orderBy: [{ issueDate: 'asc' }, { id: 'asc' }],
    });
    const paidMap = await this.computePaidAmounts(
      tx,
      rows.map((r) => r.id),
    );

    let computed = rows.map((row) =>
      this.toComputedRow(row, paidMap.get(row.id) ?? ZERO, today),
    );
    if (query.status !== undefined) {
      computed = computed.filter((c) => c.status === query.status);
    }
    return computed;
  }

  private toComputedRow(
    row: ApInvoiceRow,
    paidAmount: Prisma.Decimal,
    today: string,
  ): ApComputedRow {
    const balanceDue = row.totalAmount.minus(paidAmount);
    const { bucket, daysOverdue } = computeAgingBucket(
      row.dueDate !== null ? fromPrismaDate(row.dueDate) : null,
      today,
    );
    return {
      row,
      paidAmount,
      balanceDue,
      status: computeAccountsPayableStatus(paidAmount, row.totalAmount),
      agingBucket: bucket,
      daysOverdue,
    };
  }

  private async computePaidAmounts(
    tx: Prisma.TransactionClient,
    purchaseInvoiceIds: string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    if (purchaseInvoiceIds.length === 0) {
      return new Map();
    }
    const sums = await tx.supplierPaymentAllocation.groupBy({
      by: ['purchaseInvoiceId'],
      where: {
        purchaseInvoiceId: { in: purchaseInvoiceIds },
        supplierPayment: { status: SupplierPaymentStatus.ACTIVE },
      },
      _sum: { amount: true },
    });
    return new Map(
      sums.map((row) => [row.purchaseInvoiceId, row._sum.amount ?? ZERO]),
    );
  }

  private assertValidFilterQuery(query: AccountsPayableFilterQuery): void {
    if (
      query.issueDateFrom !== undefined &&
      !isValidDateOnly(query.issueDateFrom)
    ) {
      throw new BadRequestException(
        'issueDateFrom debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (
      query.issueDateTo !== undefined &&
      !isValidDateOnly(query.issueDateTo)
    ) {
      throw new BadRequestException(
        'issueDateTo debe ser una fecha válida en formato YYYY-MM-DD',
      );
    }
    if (
      query.issueDateFrom !== undefined &&
      query.issueDateTo !== undefined &&
      query.issueDateFrom > query.issueDateTo
    ) {
      throw new BadRequestException(
        'issueDateFrom no puede ser posterior a issueDateTo',
      );
    }
  }
}

import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { ExcelColumn } from '../common/excel/excel-column';
import { ExcelExportService } from '../common/excel/excel-export.service';
import { PrismaService } from '../database/prisma.service';
import { SettingsReader } from '../configuration/settings-reader.service';
import {
  attributeAllocation,
  buildExpensesByCurrency,
  ExpenseRow,
} from './import-expense-aggregation.helpers';
import {
  buildReconciliationRow,
  classifyReconciliation,
  ReceiptLinkRow,
  ShipmentLineRow,
} from './import-reconciliation.helpers';
import {
  CargoUnitAggregate,
  ConsolidatedReconciliationQuery,
  ConsolidatedReconciliationRow,
  ExpenseReconciliationQuery,
  ExpenseReconciliationRow,
  ImportOperationSummaryQuery,
  ImportOperationSummaryRow,
  PendingFinancialStatus,
  RelatedPurchaseInvoiceRef,
  ShipmentCountsByStatus,
  ShipmentDiscrepancyCode,
  ShipmentReconciliationQuery,
  ShipmentReconciliationRow,
} from './types/import-reports.types';

const ZERO = new Prisma.Decimal(0);
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const EXPORT_BATCH_SIZE = 500;

/**
 * Mismo alcance de lectura que el resto del dominio contable/importaciones
 * (A3.4/B4 §6): ADMIN/MANAGEMENT/ACCOUNTANT leen; SELLER/WAREHOUSE sin
 * ningún acceso a estos reportes ni a los montos de costo que exponen.
 */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
]);

function assertCanRead(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar los reportes de importación',
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

/**
 * Reportes de SOLO LECTURA de importaciones (Fase B4). Consolida B1
 * (ImportOperation/Shipment/ShipmentLine), B2 (ImportExpense/
 * AllocationBatch/Allocation) y B3 (ImportReceiptLink + atribución de
 * costo, reutilizando `computeCostAttributionSplit` — nunca una segunda
 * implementación del cálculo ya corregido). NUNCA escribe ninguna tabla,
 * nunca invoca StockMovementEngine/InventoryValuationEngine/
 * AccountingEngine, nunca activa capitalización/FX/mapeos contables: un
 * monto "asignado" (B2) o "atribuido" (B3) aquí NUNCA constituye una
 * aprobación de capitalización ni un costo de inventario reconocido
 * (CLAUDE.md B4 §3/§4).
 */
@Injectable()
export class ImportReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly excelExportService: ExcelExportService,
    private readonly settingsReader: SettingsReader,
  ) {}

  // ========================================================================
  // Reporte 1 — Resumen por operación de importación
  // ========================================================================

  async getOperationsSummary(
    query: ImportOperationSummaryQuery,
    requesterRole: RoleName,
  ): Promise<{
    data: ImportOperationSummaryRow[];
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }> {
    assertCanRead(requesterRole);
    const page = normalizePage(query.page);
    const limit = normalizeLimit(query.limit);
    const where = this.buildOperationWhere(query);

    return this.prisma.$transaction(
      async (tx) => {
        const [operations, total] = await Promise.all([
          tx.importOperation.findMany({
            where,
            select: {
              id: true,
              reference: true,
              status: true,
              originCountry: true,
              destinationCountry: true,
              createdAt: true,
              completedAt: true,
              cancelledAt: true,
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * limit,
            take: limit,
          }),
          tx.importOperation.count({ where }),
        ]);

        const companyCurrencyCode = (await this.settingsReader.getCurrent(tx))
          .currencyCode;

        const data = await Promise.all(
          operations.map(async (op) => {
            const context = await this.loadOperationContext(tx, op.id);
            return {
              id: op.id,
              reference: op.reference,
              status: op.status,
              originCountry: op.originCountry,
              destinationCountry: op.destinationCountry,
              createdAt: op.createdAt,
              completedAt: op.completedAt,
              cancelledAt: op.cancelledAt,
              shipmentCountsByStatus: await this.countShipmentsByStatus(
                tx,
                op.id,
              ),
              cargoByUnit: context.cargoByUnit,
              relatedPurchaseInvoices: context.relatedPurchaseInvoices,
              expensesByCurrency: buildExpensesByCurrency(
                context,
                companyCurrencyCode,
              ),
            };
          }),
        );

        return {
          data,
          page,
          limit,
          total,
          totalPages: total === 0 ? 0 : Math.ceil(total / limit),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async exportOperationsSummaryXlsx(
    query: ImportOperationSummaryQuery,
    requesterRole: RoleName,
  ): Promise<Buffer> {
    assertCanRead(requesterRole);
    const where = this.buildOperationWhere(query);

    const rows: ImportOperationSummaryRow[] = await this.prisma.$transaction(
      async (tx) => {
        const total = await tx.importOperation.count({ where });
        this.excelExportService.assertWithinExportLimit(
          total,
          'resumen de operaciones de importación',
        );
        const companyCurrencyCode = (await this.settingsReader.getCurrent(tx))
          .currencyCode;

        const all: ImportOperationSummaryRow[] = [];
        const totalPages =
          total === 0 ? 0 : Math.ceil(total / EXPORT_BATCH_SIZE);
        for (let p = 1; p <= totalPages; p++) {
          const operations = await tx.importOperation.findMany({
            where,
            select: {
              id: true,
              reference: true,
              status: true,
              originCountry: true,
              destinationCountry: true,
              createdAt: true,
              completedAt: true,
              cancelledAt: true,
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (p - 1) * EXPORT_BATCH_SIZE,
            take: EXPORT_BATCH_SIZE,
          });
          for (const op of operations) {
            const context = await this.loadOperationContext(tx, op.id);
            all.push({
              id: op.id,
              reference: op.reference,
              status: op.status,
              originCountry: op.originCountry,
              destinationCountry: op.destinationCountry,
              createdAt: op.createdAt,
              completedAt: op.completedAt,
              cancelledAt: op.cancelledAt,
              shipmentCountsByStatus: await this.countShipmentsByStatus(
                tx,
                op.id,
              ),
              cargoByUnit: context.cargoByUnit,
              relatedPurchaseInvoices: context.relatedPurchaseInvoices,
              expensesByCurrency: buildExpensesByCurrency(
                context,
                companyCurrencyCode,
              ),
            });
          }
        }
        return all;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 10000,
        timeout: 30000,
      },
    );

    interface ExportRow {
      reference: string;
      status: string;
      originCountry: string;
      destinationCountry: string;
      createdAt: Date;
      cargoSummary: string;
      currencyCode: string;
      expenseCount: number;
      totalAmount: number;
      allocatedAmount: number;
      unallocatedAmount: number;
      attributedAmount: number;
      unattributedAmount: number;
      financialStatus: string;
    }
    const exportRows: ExportRow[] = [];
    for (const op of rows) {
      const cargoSummary = op.cargoByUnit
        .map(
          (c) =>
            `${c.unitCode ?? 'sin-unidad'}: planificado ${c.plannedQuantity}, recibido ${c.linkedReceivedQuantity}, sin vincular ${c.unlinkedQuantity}`,
        )
        .join(' | ');
      const currencyRows =
        op.expensesByCurrency.length === 0
          ? [
              {
                currencyCode: '',
                expenseCount: 0,
                totalAmount: '0.00',
                allocatedAmount: '0.00',
                unallocatedAmount: '0.00',
                attributedAmount: '0.00',
                unattributedAmount: '0.00',
                financialStatus: '',
              },
            ]
          : op.expensesByCurrency;
      for (const c of currencyRows) {
        exportRows.push({
          reference: op.reference,
          status: op.status,
          originCountry: op.originCountry,
          destinationCountry: op.destinationCountry,
          createdAt: op.createdAt,
          cargoSummary,
          currencyCode: c.currencyCode,
          expenseCount: c.expenseCount,
          totalAmount: Number(c.totalAmount),
          allocatedAmount: Number(c.allocatedAmount),
          unallocatedAmount: Number(c.unallocatedAmount),
          attributedAmount: Number(c.attributedAmount),
          unattributedAmount: Number(c.unattributedAmount),
          financialStatus: c.financialStatus ?? '',
        });
      }
    }
    this.excelExportService.assertWithinExportLimit(
      exportRows.length,
      'resumen de operaciones de importación',
    );

    const columns: ExcelColumn<ExportRow>[] = [
      {
        key: 'reference',
        header: 'Referencia',
        type: 'string',
        value: (r) => r.reference,
        width: 20,
      },
      {
        key: 'status',
        header: 'Estado',
        type: 'string',
        value: (r) => r.status,
      },
      {
        key: 'originCountry',
        header: 'Origen',
        type: 'string',
        value: (r) => r.originCountry,
        width: 10,
      },
      {
        key: 'destinationCountry',
        header: 'Destino',
        type: 'string',
        value: (r) => r.destinationCountry,
        width: 10,
      },
      {
        key: 'createdAt',
        header: 'Creada',
        type: 'date',
        value: (r) => r.createdAt,
      },
      {
        key: 'cargoSummary',
        header: 'Carga por unidad',
        type: 'string',
        value: (r) => r.cargoSummary,
        width: 50,
      },
      {
        key: 'currencyCode',
        header: 'Moneda',
        type: 'string',
        value: (r) => r.currencyCode,
        width: 10,
      },
      {
        key: 'expenseCount',
        header: 'N° gastos',
        type: 'number',
        value: (r) => r.expenseCount,
        width: 10,
      },
      {
        key: 'totalAmount',
        header: 'Monto total',
        type: 'number',
        value: (r) => r.totalAmount,
      },
      {
        key: 'allocatedAmount',
        header: 'Asignado (B2)',
        type: 'number',
        value: (r) => r.allocatedAmount,
      },
      {
        key: 'unallocatedAmount',
        header: 'Sin asignar',
        type: 'number',
        value: (r) => r.unallocatedAmount,
      },
      {
        key: 'attributedAmount',
        header: 'Atribuido (B3)',
        type: 'number',
        value: (r) => r.attributedAmount,
      },
      {
        key: 'unattributedAmount',
        header: 'Sin atribuir',
        type: 'number',
        value: (r) => r.unattributedAmount,
      },
      {
        key: 'financialStatus',
        header: 'Estado financiero',
        type: 'string',
        value: (r) => r.financialStatus,
        width: 26,
      },
    ];

    return this.excelExportService.buildWorkbook(
      'Resumen de Importaciones',
      columns,
      exportRows,
    );
  }

  private buildOperationWhere(
    query: ImportOperationSummaryQuery | ConsolidatedReconciliationQuery,
  ): Prisma.ImportOperationWhereInput {
    const where: Prisma.ImportOperationWhereInput = {};
    if (query.importOperationId !== undefined) {
      where.id = query.importOperationId;
    }
    if (query.status !== undefined) {
      where.status = query.status;
    }
    return where;
  }

  private async countShipmentsByStatus(
    tx: Prisma.TransactionClient,
    importOperationId: string,
  ): Promise<ShipmentCountsByStatus> {
    const groups = await tx.importShipment.groupBy({
      by: ['status'],
      where: { importOperationId },
      _count: { _all: true },
    });
    const counts: ShipmentCountsByStatus = {
      PLANNED: 0,
      IN_TRANSIT: 0,
      ARRIVED: 0,
      CANCELLED: 0,
    };
    for (const g of groups) {
      counts[g.status] = g._count._all;
    }
    return counts;
  }

  // ========================================================================
  // Carga de contexto compartida (por operación) — B1 + B2 + B3
  // ========================================================================

  private async loadOperationContext(
    tx: Prisma.TransactionClient,
    importOperationId: string,
  ): Promise<{
    lines: ShipmentLineRow[];
    linksByLine: Map<string, ReceiptLinkRow[]>;
    activeLinkedTotalByLine: Map<string, Prisma.Decimal>;
    cargoByUnit: CargoUnitAggregate[];
    relatedPurchaseInvoices: RelatedPurchaseInvoiceRef[];
    expenses: ExpenseRow[];
  }> {
    const { lines, linksByLine, activeLinkedTotalByLine } =
      await this.fetchLinesWithLinks(tx, {
        importShipment: {
          importOperationId,
          status: { not: 'CANCELLED' },
        },
      });

    const cargoByUnit = this.buildCargoByUnit(lines, activeLinkedTotalByLine);

    const linkedInvoiceLines = await tx.importShipmentLine.findMany({
      where: {
        importShipment: { importOperationId, status: { not: 'CANCELLED' } },
        purchaseInvoiceLineId: { not: null },
      },
      select: {
        purchaseInvoiceLine: {
          select: {
            purchaseInvoice: {
              select: {
                id: true,
                documentType: true,
                documentSeries: true,
                documentNumber: true,
              },
            },
          },
        },
      },
    });
    const invoiceMap = new Map<string, RelatedPurchaseInvoiceRef>();
    for (const row of linkedInvoiceLines) {
      const invoice = row.purchaseInvoiceLine?.purchaseInvoice;
      if (invoice !== undefined && invoice !== null) {
        invoiceMap.set(invoice.id, invoice);
      }
    }

    const expenses = await this.fetchExpensesWithAllocations(tx, {
      importOperationId,
    });

    return {
      lines,
      linksByLine,
      activeLinkedTotalByLine,
      cargoByUnit,
      relatedPurchaseInvoices: [...invoiceMap.values()],
      expenses,
    };
  }

  private async fetchLinesWithLinks(
    tx: Prisma.TransactionClient,
    where: Prisma.ImportShipmentLineWhereInput,
  ): Promise<{
    lines: ShipmentLineRow[];
    linksByLine: Map<string, ReceiptLinkRow[]>;
    activeLinkedTotalByLine: Map<string, Prisma.Decimal>;
  }> {
    const rawLines = await tx.importShipmentLine.findMany({
      where,
      select: {
        id: true,
        importShipmentId: true,
        productId: true,
        descriptionSnapshot: true,
        unitCode: true,
        purchaseInvoiceLineId: true,
        plannedQuantity: true,
        importShipment: {
          select: { status: true, importOperationId: true },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const lines: ShipmentLineRow[] = rawLines.map((l) => ({
      id: l.id,
      importShipmentId: l.importShipmentId,
      shipmentStatus: l.importShipment.status,
      importOperationId: l.importShipment.importOperationId,
      productId: l.productId,
      descriptionSnapshot: l.descriptionSnapshot,
      unitCode: l.unitCode,
      purchaseInvoiceLineId: l.purchaseInvoiceLineId,
      plannedQuantity: l.plannedQuantity,
    }));

    const lineIds = lines.map((l) => l.id);
    const linkRows =
      lineIds.length === 0
        ? []
        : await tx.importReceiptLink.findMany({
            where: { importShipmentLineId: { in: lineIds } },
            select: {
              id: true,
              importShipmentLineId: true,
              purchaseReceiptLineId: true,
              linkedQuantity: true,
              status: true,
              purchaseReceiptLine: {
                select: {
                  purchaseReceiptId: true,
                  purchaseInvoiceLineId: true,
                  purchaseReceipt: { select: { status: true } },
                  purchaseInvoiceLine: { select: { productId: true } },
                },
              },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          });

    const linksByLine = new Map<string, ReceiptLinkRow[]>();
    const activeLinkedTotalByLine = new Map<string, Prisma.Decimal>();
    for (const row of linkRows) {
      const mapped: ReceiptLinkRow = {
        importReceiptLinkId: row.id,
        importShipmentLineId: row.importShipmentLineId,
        purchaseReceiptLineId: row.purchaseReceiptLineId,
        purchaseReceiptId: row.purchaseReceiptLine.purchaseReceiptId,
        receiptStatus: row.purchaseReceiptLine.purchaseReceipt.status,
        linkStatus: row.status,
        linkedQuantity: row.linkedQuantity,
        receiptLineProductId:
          row.purchaseReceiptLine.purchaseInvoiceLine.productId,
        receiptLinePurchaseInvoiceLineId:
          row.purchaseReceiptLine.purchaseInvoiceLineId,
      };
      const arr = linksByLine.get(row.importShipmentLineId) ?? [];
      arr.push(mapped);
      linksByLine.set(row.importShipmentLineId, arr);
      if (row.status === 'ACTIVE') {
        activeLinkedTotalByLine.set(
          row.importShipmentLineId,
          (activeLinkedTotalByLine.get(row.importShipmentLineId) ?? ZERO).plus(
            row.linkedQuantity,
          ),
        );
      }
    }

    return { lines, linksByLine, activeLinkedTotalByLine };
  }

  private buildCargoByUnit(
    lines: ShipmentLineRow[],
    activeLinkedTotalByLine: Map<string, Prisma.Decimal>,
  ): CargoUnitAggregate[] {
    const byUnit = new Map<
      string | null,
      { planned: Prisma.Decimal; received: Prisma.Decimal }
    >();
    for (const line of lines) {
      const bucket = byUnit.get(line.unitCode) ?? {
        planned: ZERO,
        received: ZERO,
      };
      bucket.planned = bucket.planned.plus(line.plannedQuantity);
      bucket.received = bucket.received.plus(
        activeLinkedTotalByLine.get(line.id) ?? ZERO,
      );
      byUnit.set(line.unitCode, bucket);
    }
    return [...byUnit.entries()].map(([unitCode, { planned, received }]) => {
      const unlinked = planned.minus(received);
      return {
        unitCode,
        plannedQuantity: planned.toFixed(3),
        linkedReceivedQuantity: received.toFixed(3),
        unlinkedQuantity: (unlinked.lessThan(0) ? ZERO : unlinked).toFixed(3),
      };
    });
  }

  private async fetchExpensesWithAllocations(
    tx: Prisma.TransactionClient,
    where: Prisma.ImportExpenseWhereInput,
  ): Promise<ExpenseRow[]> {
    const rows = await tx.importExpense.findMany({
      where,
      select: {
        id: true,
        importOperationId: true,
        category: true,
        documentReference: true,
        supplierId: true,
        currencyCode: true,
        amount: true,
        status: true,
        allocationBatches: {
          select: {
            allocations: {
              select: { importShipmentLineId: true, amount: true },
            },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      importOperationId: r.importOperationId,
      category: r.category,
      documentReference: r.documentReference,
      supplierId: r.supplierId,
      currencyCode: r.currencyCode,
      amount: r.amount,
      status: r.status,
      allocations: r.allocationBatches.flatMap((b) => b.allocations),
    }));
  }

  // ========================================================================
  // Reporte 2 — Reconciliación embarque / recepción
  // ========================================================================

  async getShipmentReconciliation(
    query: ShipmentReconciliationQuery,
    requesterRole: RoleName,
  ): Promise<{
    data: ShipmentReconciliationRow[];
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }> {
    assertCanRead(requesterRole);
    const page = normalizePage(query.page);
    const limit = normalizeLimit(query.limit);
    const where = this.buildShipmentLineWhere(query);

    return this.prisma.$transaction(
      async (tx) => {
        if (query.onlyWithDiscrepancies !== true) {
          const [{ lines, linksByLine }, total] = await Promise.all([
            this.fetchLinesWithLinksPage(tx, where, (page - 1) * limit, limit),
            tx.importShipmentLine.count({ where }),
          ]);
          const data = lines.map((line) =>
            buildReconciliationRow(line, linksByLine.get(line.id) ?? []),
          );
          return {
            data,
            page,
            limit,
            total,
            totalPages: total === 0 ? 0 : Math.ceil(total / limit),
          };
        }

        // Filtrar por discrepancia exige evaluar el conjunto COMPLETO antes
        // de paginar (la discrepancia es derivada, nunca una columna
        // filtrable en SQL) — acotado por el resto de filtros explícitos.
        const { lines, linksByLine } = await this.fetchLinesWithLinks(
          tx,
          where,
        );
        const withDiscrepancies = lines
          .map((line) =>
            buildReconciliationRow(line, linksByLine.get(line.id) ?? []),
          )
          .filter((row) => row.discrepancyCodes.length > 0);
        const total = withDiscrepancies.length;
        const skip = (page - 1) * limit;
        return {
          data: withDiscrepancies.slice(skip, skip + limit),
          page,
          limit,
          total,
          totalPages: total === 0 ? 0 : Math.ceil(total / limit),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async exportShipmentReconciliationXlsx(
    query: ShipmentReconciliationQuery,
    requesterRole: RoleName,
  ): Promise<Buffer> {
    assertCanRead(requesterRole);
    const where = this.buildShipmentLineWhere(query);

    const rows: ShipmentReconciliationRow[] = await this.prisma.$transaction(
      async (tx) => {
        const { lines, linksByLine } = await this.fetchLinesWithLinks(
          tx,
          where,
        );
        const all = lines.map((line) =>
          buildReconciliationRow(line, linksByLine.get(line.id) ?? []),
        );
        return query.onlyWithDiscrepancies === true
          ? all.filter((r) => r.discrepancyCodes.length > 0)
          : all;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 10000,
        timeout: 30000,
      },
    );
    this.excelExportService.assertWithinExportLimit(
      rows.length,
      'reconciliación de embarques y recepciones',
    );

    interface ExportRow {
      importShipmentLineId: string;
      importOperationId: string;
      shipmentStatus: string;
      descriptionSnapshot: string;
      unitCode: string;
      plannedQuantity: number;
      linkedQuantity: number;
      remainingQuantity: number;
      activeLinksCount: number;
      discrepancyCodes: string;
    }
    const exportRows: ExportRow[] = rows.map((r) => ({
      importShipmentLineId: r.importShipmentLineId,
      importOperationId: r.importOperationId,
      shipmentStatus: r.shipmentStatus,
      descriptionSnapshot: r.descriptionSnapshot,
      unitCode: r.unitCode ?? '',
      plannedQuantity: Number(r.plannedQuantity),
      linkedQuantity: Number(r.linkedQuantity),
      remainingQuantity: Number(r.remainingQuantity),
      activeLinksCount: r.links.filter((l) => l.linkStatus === 'ACTIVE').length,
      discrepancyCodes: r.discrepancyCodes.join(', '),
    }));

    const columns: ExcelColumn<ExportRow>[] = [
      {
        key: 'importShipmentLineId',
        header: 'ID línea de embarque',
        type: 'identifier',
        value: (r) => r.importShipmentLineId,
        width: 38,
      },
      {
        key: 'importOperationId',
        header: 'ID operación',
        type: 'identifier',
        value: (r) => r.importOperationId,
        width: 38,
      },
      {
        key: 'shipmentStatus',
        header: 'Estado del embarque',
        type: 'string',
        value: (r) => r.shipmentStatus,
      },
      {
        key: 'descriptionSnapshot',
        header: 'Descripción',
        type: 'string',
        value: (r) => r.descriptionSnapshot,
        width: 30,
      },
      {
        key: 'unitCode',
        header: 'Unidad',
        type: 'string',
        value: (r) => r.unitCode,
      },
      {
        key: 'plannedQuantity',
        header: 'Cant. embarcada',
        type: 'number',
        value: (r) => r.plannedQuantity,
      },
      {
        key: 'linkedQuantity',
        header: 'Cant. vinculada (ACTIVE)',
        type: 'number',
        value: (r) => r.linkedQuantity,
      },
      {
        key: 'remainingQuantity',
        header: 'Cant. sin vincular',
        type: 'number',
        value: (r) => r.remainingQuantity,
      },
      {
        key: 'activeLinksCount',
        header: 'N° recepciones vinculadas',
        type: 'number',
        value: (r) => r.activeLinksCount,
      },
      {
        key: 'discrepancyCodes',
        header: 'Discrepancias',
        type: 'string',
        value: (r) => r.discrepancyCodes,
        width: 40,
      },
    ];

    return this.excelExportService.buildWorkbook(
      'Reconciliacion Embarques',
      columns,
      exportRows,
    );
  }

  private buildShipmentLineWhere(
    query: ShipmentReconciliationQuery,
  ): Prisma.ImportShipmentLineWhereInput {
    const importShipment: Prisma.ImportShipmentWhereInput = {
      status: { not: 'CANCELLED' },
    };
    if (query.importOperationId !== undefined) {
      importShipment.importOperationId = query.importOperationId;
    }
    if (query.shipmentStatus !== undefined) {
      importShipment.status = query.shipmentStatus;
    }
    return { importShipment };
  }

  private async fetchLinesWithLinksPage(
    tx: Prisma.TransactionClient,
    where: Prisma.ImportShipmentLineWhereInput,
    skip: number,
    take: number,
  ): Promise<{
    lines: ShipmentLineRow[];
    linksByLine: Map<string, ReceiptLinkRow[]>;
  }> {
    const rawLines = await tx.importShipmentLine.findMany({
      where,
      select: {
        id: true,
        importShipmentId: true,
        productId: true,
        descriptionSnapshot: true,
        unitCode: true,
        purchaseInvoiceLineId: true,
        plannedQuantity: true,
        importShipment: {
          select: { status: true, importOperationId: true },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take,
    });
    const lines: ShipmentLineRow[] = rawLines.map((l) => ({
      id: l.id,
      importShipmentId: l.importShipmentId,
      shipmentStatus: l.importShipment.status,
      importOperationId: l.importShipment.importOperationId,
      productId: l.productId,
      descriptionSnapshot: l.descriptionSnapshot,
      unitCode: l.unitCode,
      purchaseInvoiceLineId: l.purchaseInvoiceLineId,
      plannedQuantity: l.plannedQuantity,
    }));

    const lineIds = lines.map((l) => l.id);
    const linksByLine = await this.fetchLinksForLineIds(tx, lineIds);
    return { lines, linksByLine };
  }

  private async fetchLinksForLineIds(
    tx: Prisma.TransactionClient,
    lineIds: string[],
  ): Promise<Map<string, ReceiptLinkRow[]>> {
    const linksByLine = new Map<string, ReceiptLinkRow[]>();
    if (lineIds.length === 0) {
      return linksByLine;
    }
    const linkRows = await tx.importReceiptLink.findMany({
      where: { importShipmentLineId: { in: lineIds } },
      select: {
        id: true,
        importShipmentLineId: true,
        purchaseReceiptLineId: true,
        linkedQuantity: true,
        status: true,
        purchaseReceiptLine: {
          select: {
            purchaseReceiptId: true,
            purchaseInvoiceLineId: true,
            purchaseReceipt: { select: { status: true } },
            purchaseInvoiceLine: { select: { productId: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const row of linkRows) {
      const mapped: ReceiptLinkRow = {
        importReceiptLinkId: row.id,
        importShipmentLineId: row.importShipmentLineId,
        purchaseReceiptLineId: row.purchaseReceiptLineId,
        purchaseReceiptId: row.purchaseReceiptLine.purchaseReceiptId,
        receiptStatus: row.purchaseReceiptLine.purchaseReceipt.status,
        linkStatus: row.status,
        linkedQuantity: row.linkedQuantity,
        receiptLineProductId:
          row.purchaseReceiptLine.purchaseInvoiceLine.productId,
        receiptLinePurchaseInvoiceLineId:
          row.purchaseReceiptLine.purchaseInvoiceLineId,
      };
      const arr = linksByLine.get(row.importShipmentLineId) ?? [];
      arr.push(mapped);
      linksByLine.set(row.importShipmentLineId, arr);
    }
    return linksByLine;
  }

  // ========================================================================
  // Reporte 3 — Reconciliación de gastos de importación
  // ========================================================================

  async getExpenseReconciliation(
    query: ExpenseReconciliationQuery,
    requesterRole: RoleName,
  ): Promise<{
    data: ExpenseReconciliationRow[];
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }> {
    assertCanRead(requesterRole);
    const page = normalizePage(query.page);
    const limit = normalizeLimit(query.limit);
    const where = this.buildExpenseWhere(query);

    return this.prisma.$transaction(
      async (tx) => {
        const [total, companyCurrencyCode] = await Promise.all([
          tx.importExpense.count({ where }),
          this.settingsReader.getCurrent(tx).then((s) => s.currencyCode),
        ]);
        const pageRows = await tx.importExpense.findMany({
          where,
          select: {
            id: true,
            importOperationId: true,
            category: true,
            documentReference: true,
            supplierId: true,
            currencyCode: true,
            amount: true,
            status: true,
            allocationBatches: {
              select: {
                allocations: {
                  select: { importShipmentLineId: true, amount: true },
                },
              },
            },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        });

        const lineIds = [
          ...new Set(
            pageRows.flatMap((e) =>
              e.allocationBatches.flatMap((b) =>
                b.allocations.map((a) => a.importShipmentLineId),
              ),
            ),
          ),
        ];
        const { plannedByLine, activeLinkedTotalByLine } =
          await this.loadLineQuantities(tx, lineIds);

        const data = pageRows.map((row) =>
          this.buildExpenseReconciliationRow(
            {
              id: row.id,
              importOperationId: row.importOperationId,
              category: row.category,
              documentReference: row.documentReference,
              supplierId: row.supplierId,
              currencyCode: row.currencyCode,
              amount: row.amount,
              status: row.status,
              allocations: row.allocationBatches.flatMap((b) => b.allocations),
            },
            plannedByLine,
            activeLinkedTotalByLine,
            companyCurrencyCode,
          ),
        );

        return {
          data,
          page,
          limit,
          total,
          totalPages: total === 0 ? 0 : Math.ceil(total / limit),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async exportExpenseReconciliationXlsx(
    query: ExpenseReconciliationQuery,
    requesterRole: RoleName,
  ): Promise<Buffer> {
    assertCanRead(requesterRole);
    const where = this.buildExpenseWhere(query);

    const rows: ExpenseReconciliationRow[] = await this.prisma.$transaction(
      async (tx) => {
        const total = await tx.importExpense.count({ where });
        this.excelExportService.assertWithinExportLimit(
          total,
          'reconciliación de gastos de importación',
        );
        const companyCurrencyCode = (await this.settingsReader.getCurrent(tx))
          .currencyCode;
        const expenses = await this.fetchExpensesWithAllocations(tx, where);
        const lineIds = [
          ...new Set(
            expenses.flatMap((e) =>
              e.allocations.map((a) => a.importShipmentLineId),
            ),
          ),
        ];
        const { plannedByLine, activeLinkedTotalByLine } =
          await this.loadLineQuantities(tx, lineIds);
        return expenses.map((e) =>
          this.buildExpenseReconciliationRow(
            e,
            plannedByLine,
            activeLinkedTotalByLine,
            companyCurrencyCode,
          ),
        );
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 10000,
        timeout: 30000,
      },
    );

    interface ExportRow {
      importExpenseId: string;
      importOperationId: string;
      category: string;
      documentReference: string;
      currencyCode: string;
      amount: number;
      status: string;
      allocatedAmount: number;
      unallocatedAmount: number;
      attributedAmount: number;
      unattributedAmount: number;
      financialStatus: string;
    }
    const exportRows: ExportRow[] = rows.map((r) => ({
      importExpenseId: r.importExpenseId,
      importOperationId: r.importOperationId,
      category: r.category,
      documentReference: r.documentReference ?? '',
      currencyCode: r.currencyCode,
      amount: Number(r.amount),
      status: r.status,
      allocatedAmount: Number(r.allocatedAmount),
      unallocatedAmount: Number(r.unallocatedAmount),
      attributedAmount: Number(r.attributedAmount),
      unattributedAmount: Number(r.unattributedAmount),
      financialStatus: r.financialStatus ?? '',
    }));

    const columns: ExcelColumn<ExportRow>[] = [
      {
        key: 'importExpenseId',
        header: 'ID gasto',
        type: 'identifier',
        value: (r) => r.importExpenseId,
        width: 38,
      },
      {
        key: 'importOperationId',
        header: 'ID operación',
        type: 'identifier',
        value: (r) => r.importOperationId,
        width: 38,
      },
      {
        key: 'category',
        header: 'Categoría',
        type: 'string',
        value: (r) => r.category,
      },
      {
        key: 'documentReference',
        header: 'Documento',
        type: 'string',
        value: (r) => r.documentReference,
        width: 20,
      },
      {
        key: 'currencyCode',
        header: 'Moneda',
        type: 'string',
        value: (r) => r.currencyCode,
      },
      {
        key: 'amount',
        header: 'Monto',
        type: 'number',
        value: (r) => r.amount,
      },
      {
        key: 'status',
        header: 'Estado',
        type: 'string',
        value: (r) => r.status,
      },
      {
        key: 'allocatedAmount',
        header: 'Asignado (B2)',
        type: 'number',
        value: (r) => r.allocatedAmount,
      },
      {
        key: 'unallocatedAmount',
        header: 'Sin asignar',
        type: 'number',
        value: (r) => r.unallocatedAmount,
      },
      {
        key: 'attributedAmount',
        header: 'Atribuido (B3)',
        type: 'number',
        value: (r) => r.attributedAmount,
      },
      {
        key: 'unattributedAmount',
        header: 'Sin atribuir',
        type: 'number',
        value: (r) => r.unattributedAmount,
      },
      {
        key: 'financialStatus',
        header: 'Estado financiero',
        type: 'string',
        value: (r) => r.financialStatus,
        width: 26,
      },
    ];

    return this.excelExportService.buildWorkbook(
      'Reconciliacion Gastos',
      columns,
      exportRows,
    );
  }

  private buildExpenseWhere(
    query: ExpenseReconciliationQuery,
  ): Prisma.ImportExpenseWhereInput {
    const where: Prisma.ImportExpenseWhereInput = {};
    if (query.importOperationId !== undefined) {
      where.importOperationId = query.importOperationId;
    }
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.currencyCode !== undefined) {
      where.currencyCode = query.currencyCode.toUpperCase();
    }
    return where;
  }

  private async loadLineQuantities(
    tx: Prisma.TransactionClient,
    lineIds: string[],
  ): Promise<{
    plannedByLine: Map<string, Prisma.Decimal>;
    activeLinkedTotalByLine: Map<string, Prisma.Decimal>;
  }> {
    if (lineIds.length === 0) {
      return { plannedByLine: new Map(), activeLinkedTotalByLine: new Map() };
    }
    const [lineRows, linkRows] = await Promise.all([
      tx.importShipmentLine.findMany({
        where: { id: { in: lineIds } },
        select: { id: true, plannedQuantity: true },
      }),
      tx.importReceiptLink.findMany({
        where: { importShipmentLineId: { in: lineIds }, status: 'ACTIVE' },
        select: { importShipmentLineId: true, linkedQuantity: true },
      }),
    ]);
    const plannedByLine = new Map(
      lineRows.map((l) => [l.id, l.plannedQuantity]),
    );
    const activeLinkedTotalByLine = new Map<string, Prisma.Decimal>();
    for (const link of linkRows) {
      activeLinkedTotalByLine.set(
        link.importShipmentLineId,
        (activeLinkedTotalByLine.get(link.importShipmentLineId) ?? ZERO).plus(
          link.linkedQuantity,
        ),
      );
    }
    return { plannedByLine, activeLinkedTotalByLine };
  }

  private buildExpenseReconciliationRow(
    expense: ExpenseRow,
    plannedByLine: Map<string, Prisma.Decimal>,
    activeLinkedTotalByLine: Map<string, Prisma.Decimal>,
    companyCurrencyCode: string,
  ): ExpenseReconciliationRow {
    let allocatedAmount = ZERO;
    let attributedAmount = ZERO;
    for (const allocation of expense.allocations) {
      allocatedAmount = allocatedAmount.plus(allocation.amount);
      attributedAmount = attributedAmount.plus(
        attributeAllocation(allocation, plannedByLine, activeLinkedTotalByLine),
      );
    }
    const unallocated = expense.amount.minus(allocatedAmount);
    const unattributed = allocatedAmount.minus(attributedAmount);
    const financialStatus: PendingFinancialStatus | null =
      allocatedAmount.isZero()
        ? null
        : expense.currencyCode !== companyCurrencyCode
          ? 'PENDING_FX'
          : 'PENDING_ACCOUNTING_POLICY';

    return {
      importExpenseId: expense.id,
      importOperationId: expense.importOperationId,
      category: expense.category as ExpenseReconciliationRow['category'],
      documentReference: expense.documentReference,
      supplierId: expense.supplierId,
      currencyCode: expense.currencyCode,
      amount: expense.amount.toFixed(2),
      status: expense.status,
      allocatedAmount: allocatedAmount.toFixed(2),
      unallocatedAmount: (unallocated.lessThan(0) ? ZERO : unallocated).toFixed(
        2,
      ),
      attributedAmount: attributedAmount.toFixed(2),
      unattributedAmount: (unattributed.lessThan(0)
        ? ZERO
        : unattributed
      ).toFixed(2),
      financialStatus,
    };
  }

  // ========================================================================
  // Reporte 4 — Reconciliación consolidada
  // ========================================================================

  async getConsolidatedReconciliation(
    query: ConsolidatedReconciliationQuery,
    requesterRole: RoleName,
  ): Promise<{
    data: ConsolidatedReconciliationRow[];
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }> {
    assertCanRead(requesterRole);
    const page = normalizePage(query.page);
    const limit = normalizeLimit(query.limit);
    const where = this.buildOperationWhere(query);

    return this.prisma.$transaction(
      async (tx) => {
        const [operations, total] = await Promise.all([
          tx.importOperation.findMany({
            where,
            select: { id: true, reference: true, status: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * limit,
            take: limit,
          }),
          tx.importOperation.count({ where }),
        ]);
        const companyCurrencyCode = (await this.settingsReader.getCurrent(tx))
          .currencyCode;

        let data: ConsolidatedReconciliationRow[] = await Promise.all(
          operations.map(async (op) => {
            const { lines, linksByLine, ...context } =
              await this.loadOperationContext(tx, op.id);
            const discrepancyCodes = this.collectDiscrepancyCodes(
              lines,
              linksByLine,
            );
            const expensesByCurrency = buildExpensesByCurrency(
              { ...context, lines },
              companyCurrencyCode,
            );
            const { status, reasons } = classifyReconciliation(
              discrepancyCodes,
              expensesByCurrency,
            );
            return {
              importOperationId: op.id,
              reference: op.reference,
              operationStatus: op.status,
              reconciliationStatus: status,
              reasons,
              cargoByUnit: context.cargoByUnit,
              expensesByCurrency,
              discrepancyCodes,
            };
          }),
        );

        if (query.reconciliationStatus !== undefined) {
          data = data.filter(
            (row) => row.reconciliationStatus === query.reconciliationStatus,
          );
        }

        return {
          data,
          page,
          limit,
          total,
          totalPages: total === 0 ? 0 : Math.ceil(total / limit),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async exportConsolidatedReconciliationXlsx(
    query: ConsolidatedReconciliationQuery,
    requesterRole: RoleName,
  ): Promise<Buffer> {
    assertCanRead(requesterRole);
    const where = this.buildOperationWhere(query);

    const rows: ConsolidatedReconciliationRow[] =
      await this.prisma.$transaction(
        async (tx) => {
          const total = await tx.importOperation.count({ where });
          this.excelExportService.assertWithinExportLimit(
            total,
            'reconciliación consolidada de importaciones',
          );
          const companyCurrencyCode = (await this.settingsReader.getCurrent(tx))
            .currencyCode;

          const all: ConsolidatedReconciliationRow[] = [];
          const totalPages =
            total === 0 ? 0 : Math.ceil(total / EXPORT_BATCH_SIZE);
          for (let p = 1; p <= totalPages; p++) {
            const operations = await tx.importOperation.findMany({
              where,
              select: { id: true, reference: true, status: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              skip: (p - 1) * EXPORT_BATCH_SIZE,
              take: EXPORT_BATCH_SIZE,
            });
            for (const op of operations) {
              const { lines, linksByLine, ...context } =
                await this.loadOperationContext(tx, op.id);
              const discrepancyCodes = this.collectDiscrepancyCodes(
                lines,
                linksByLine,
              );
              const expensesByCurrency = buildExpensesByCurrency(
                { ...context, lines },
                companyCurrencyCode,
              );
              const { status, reasons } = classifyReconciliation(
                discrepancyCodes,
                expensesByCurrency,
              );
              if (
                query.reconciliationStatus !== undefined &&
                status !== query.reconciliationStatus
              ) {
                continue;
              }
              all.push({
                importOperationId: op.id,
                reference: op.reference,
                operationStatus: op.status,
                reconciliationStatus: status,
                reasons,
                cargoByUnit: context.cargoByUnit,
                expensesByCurrency,
                discrepancyCodes,
              });
            }
          }
          return all;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          maxWait: 10000,
          timeout: 30000,
        },
      );

    interface ExportRow {
      importOperationId: string;
      reference: string;
      operationStatus: string;
      reconciliationStatus: string;
      reasons: string;
      currencyCode: string;
      allocatedAmount: number;
      attributedAmount: number;
      unattributedAmount: number;
      discrepancyCodes: string;
    }
    const exportRows: ExportRow[] = [];
    for (const row of rows) {
      const currencyRows =
        row.expensesByCurrency.length === 0
          ? [
              {
                currencyCode: '',
                allocatedAmount: '0.00',
                attributedAmount: '0.00',
                unattributedAmount: '0.00',
              },
            ]
          : row.expensesByCurrency;
      for (const c of currencyRows) {
        exportRows.push({
          importOperationId: row.importOperationId,
          reference: row.reference,
          operationStatus: row.operationStatus,
          reconciliationStatus: row.reconciliationStatus,
          reasons: row.reasons.join(' | '),
          currencyCode: c.currencyCode,
          allocatedAmount: Number(c.allocatedAmount),
          attributedAmount: Number(c.attributedAmount),
          unattributedAmount: Number(c.unattributedAmount),
          discrepancyCodes: row.discrepancyCodes.join(', '),
        });
      }
    }
    this.excelExportService.assertWithinExportLimit(
      exportRows.length,
      'reconciliación consolidada de importaciones',
    );

    const columns: ExcelColumn<ExportRow>[] = [
      {
        key: 'importOperationId',
        header: 'ID operación',
        type: 'identifier',
        value: (r) => r.importOperationId,
        width: 38,
      },
      {
        key: 'reference',
        header: 'Referencia',
        type: 'string',
        value: (r) => r.reference,
        width: 20,
      },
      {
        key: 'operationStatus',
        header: 'Estado operación',
        type: 'string',
        value: (r) => r.operationStatus,
      },
      {
        key: 'reconciliationStatus',
        header: 'Estado de reconciliación',
        type: 'string',
        value: (r) => r.reconciliationStatus,
        width: 30,
      },
      {
        key: 'reasons',
        header: 'Motivos',
        type: 'string',
        value: (r) => r.reasons,
        width: 50,
      },
      {
        key: 'currencyCode',
        header: 'Moneda',
        type: 'string',
        value: (r) => r.currencyCode,
      },
      {
        key: 'allocatedAmount',
        header: 'Asignado (B2)',
        type: 'number',
        value: (r) => r.allocatedAmount,
      },
      {
        key: 'attributedAmount',
        header: 'Atribuido (B3)',
        type: 'number',
        value: (r) => r.attributedAmount,
      },
      {
        key: 'unattributedAmount',
        header: 'Sin atribuir',
        type: 'number',
        value: (r) => r.unattributedAmount,
      },
      {
        key: 'discrepancyCodes',
        header: 'Discrepancias',
        type: 'string',
        value: (r) => r.discrepancyCodes,
        width: 40,
      },
    ];

    return this.excelExportService.buildWorkbook(
      'Reconciliacion Consolidada',
      columns,
      exportRows,
    );
  }

  private collectDiscrepancyCodes(
    lines: ShipmentLineRow[],
    linksByLine: Map<string, ReceiptLinkRow[]>,
  ): ShipmentDiscrepancyCode[] {
    const codes = new Set<ShipmentDiscrepancyCode>();
    for (const line of lines) {
      const row = buildReconciliationRow(line, linksByLine.get(line.id) ?? []);
      row.discrepancyCodes.forEach((c) => codes.add(c));
    }
    return [...codes];
  }
}

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { ExcelExportService } from '../common/excel/excel-export.service';
import { PrismaService } from '../database/prisma.service';
import { AccountsPayableService } from './accounts-payable.service';

const INVOICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVOICE_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUPPLIER_ID = '99999999-9999-4999-8999-999999999999';
const SUPPLIER_ID_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENTRY_ID = '44444444-4444-4444-8444-444444444444';
const LIABILITY_ACCOUNT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function makeInvoiceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: INVOICE_ID,
    supplierId: SUPPLIER_ID,
    documentType: 'FACTURA',
    documentSeries: 'F001',
    documentNumber: '123',
    issueDate: new Date('2026-03-01T00:00:00.000Z'),
    dueDate: null,
    currencyCode: 'PEN',
    totalAmount: d('150.00'),
    postedEntryId: ENTRY_ID,
    supplier: { legalName: 'Proveedor Uno', documentNumber: '20123456789' },
    status: 'CONFIRMED',
    ...overrides,
  };
}

function createTxMock() {
  return {
    purchaseInvoice: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
    },
    supplierPaymentAllocation: {
      groupBy: jest.fn<Promise<unknown[]>, [unknown]>(),
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    accountingEntryLine: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      groupBy: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    account: { findMany: jest.fn<Promise<unknown[]>, [unknown]>() },
  };
}

function createPrismaMock() {
  const tx = createTxMock();
  return {
    tx,
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createExcelExportServiceMock() {
  return {
    assertWithinExportLimit: jest.fn(),
    buildWorkbook: jest.fn<Promise<Buffer>, [unknown, unknown, unknown]>(),
  };
}

describe('AccountsPayableService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let excelExportService: ReturnType<typeof createExcelExportServiceMock>;
  let service: AccountsPayableService;

  beforeEach(() => {
    prisma = createPrismaMock();
    excelExportService = createExcelExportServiceMock();
    excelExportService.buildWorkbook.mockResolvedValue(Buffer.from(''));

    prisma.tx.purchaseInvoice.findMany.mockResolvedValue([makeInvoiceRow()]);
    prisma.tx.supplierPaymentAllocation.groupBy.mockResolvedValue([]);
    prisma.tx.accountingEntryLine.findMany.mockResolvedValue([]);
    prisma.tx.accountingEntryLine.groupBy.mockResolvedValue([]);
    prisma.tx.account.findMany.mockResolvedValue([]);
    prisma.tx.purchaseInvoice.findUnique.mockResolvedValue(makeInvoiceRow());
    prisma.tx.supplierPaymentAllocation.findMany.mockResolvedValue([]);

    service = new AccountsPayableService(
      prisma as unknown as PrismaService,
      excelExportService as unknown as ExcelExportService,
    );
  });

  describe('permisos', () => {
    it.each([RoleName.SELLER, RoleName.WAREHOUSE])(
      '%s no puede leer ningún reporte',
      async (role) => {
        await expect(service.list({}, role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(
          service.getDetail(INVOICE_ID, role),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.getSummary({}, role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(service.getAging({}, role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(
          service.getReconciliation({}, role),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );

    it.each([RoleName.ADMIN, RoleName.MANAGEMENT, RoleName.ACCOUNTANT])(
      '%s puede leer todos los reportes',
      async (role) => {
        await expect(service.list({}, role)).resolves.toBeDefined();
        await expect(service.getSummary({}, role)).resolves.toBeDefined();
        await expect(service.getAging({}, role)).resolves.toBeDefined();
        await expect(
          service.getReconciliation({}, role),
        ).resolves.toBeDefined();
      },
    );
  });

  describe('list', () => {
    it('filtra siempre por status=CONFIRMED', async () => {
      await service.list({}, RoleName.ADMIN);
      const call = prisma.tx.purchaseInvoice.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where.status).toBe('CONFIRMED');
    });

    it('sin pagos ACTIVE: paidAmount=0.00, balanceDue=totalAmount, status=UNPAID, agingBucket=NO_DUE_DATE (sin dueDate)', async () => {
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.data[0].paidAmount).toBe('0.00');
      expect(result.data[0].balanceDue).toBe('150.00');
      expect(result.data[0].status).toBe('UNPAID');
      expect(result.data[0].agingBucket).toBe('NO_DUE_DATE');
      expect(result.data[0].daysOverdue).toBeNull();
      expect(result.data[0].supplierLegalName).toBe('Proveedor Uno');
    });

    it('con pago ACTIVE parcial: balanceDue/status recalculados desde la agregación', async () => {
      prisma.tx.supplierPaymentAllocation.groupBy.mockResolvedValue([
        { purchaseInvoiceId: INVOICE_ID, _sum: { amount: d('50.00') } },
      ]);
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.data[0].paidAmount).toBe('50.00');
      expect(result.data[0].balanceDue).toBe('100.00');
      expect(result.data[0].status).toBe('PARTIALLY_PAID');
    });

    it('pago ACTIVE que cubre el total: status=PAID', async () => {
      prisma.tx.supplierPaymentAllocation.groupBy.mockResolvedValue([
        { purchaseInvoiceId: INVOICE_ID, _sum: { amount: d('150.00') } },
      ]);
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.data[0].status).toBe('PAID');
    });

    it('filtro agingBucket: excluye facturas de otro bucket', async () => {
      const result = await service.list(
        { agingBucket: 'OVERDUE_1_30' },
        RoleName.ADMIN,
      );
      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('fechas inválidas: BadRequestException', async () => {
      await expect(
        service.list({ issueDateFrom: 'no-es-fecha' }, RoleName.ADMIN),
      ).rejects.toThrow();
    });

    it('issueDateFrom posterior a issueDateTo: BadRequestException', async () => {
      await expect(
        service.list(
          { issueDateFrom: '2026-03-01', issueDateTo: '2026-01-01' },
          RoleName.ADMIN,
        ),
      ).rejects.toThrow();
    });
  });

  describe('getDetail', () => {
    it('factura inexistente: NotFoundException', async () => {
      prisma.tx.purchaseInvoice.findUnique.mockResolvedValue(null);
      await expect(
        service.getDetail(INVOICE_ID, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('factura DRAFT/CANCELLED: NotFoundException (nunca es una cuenta por pagar)', async () => {
      prisma.tx.purchaseInvoice.findUnique.mockResolvedValue(
        makeInvoiceRow({ status: 'DRAFT' }),
      );
      await expect(
        service.getDetail(INVOICE_ID, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('incluye historial de pagos ACTIVE y CANCELLED, pero el saldo solo cuenta los ACTIVE', async () => {
      prisma.tx.supplierPaymentAllocation.groupBy.mockResolvedValue([
        { purchaseInvoiceId: INVOICE_ID, _sum: { amount: d('50.00') } },
      ]);
      prisma.tx.supplierPaymentAllocation.findMany.mockResolvedValue([
        {
          amount: d('50.00'),
          createdAt: new Date('2026-03-05T00:00:00.000Z'),
          supplierPayment: {
            id: 'payment-1',
            status: 'ACTIVE',
            paymentDate: new Date('2026-03-05T00:00:00.000Z'),
            paymentMethodCode: 'CASH',
            reference: null,
          },
        },
        {
          amount: d('30.00'),
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
          supplierPayment: {
            id: 'payment-2',
            status: 'CANCELLED',
            paymentDate: new Date('2026-03-01T00:00:00.000Z'),
            paymentMethodCode: 'TRANSFER',
            reference: 'OP-001',
          },
        },
      ]);

      const result = await service.getDetail(INVOICE_ID, RoleName.ADMIN);

      expect(result.paidAmount).toBe('50.00');
      expect(result.payments).toHaveLength(2);
      expect(result.payments.map((p) => p.status)).toEqual([
        'ACTIVE',
        'CANCELLED',
      ]);
    });
  });

  describe('getSummary', () => {
    it('agrupa por proveedor y calcula el total general', async () => {
      prisma.tx.purchaseInvoice.findMany.mockResolvedValue([
        makeInvoiceRow({ totalAmount: d('100.00') }),
        makeInvoiceRow({
          id: INVOICE_ID_2,
          supplierId: SUPPLIER_ID_2,
          totalAmount: d('50.00'),
          supplier: {
            legalName: 'Proveedor Dos',
            documentNumber: '20999999999',
          },
        }),
      ]);
      prisma.tx.supplierPaymentAllocation.groupBy.mockResolvedValue([
        { purchaseInvoiceId: INVOICE_ID, _sum: { amount: d('40.00') } },
      ]);

      const result = await service.getSummary({}, RoleName.ADMIN);

      expect(result.bySupplier).toHaveLength(2);
      const supplierOne = result.bySupplier.find(
        (s) => s.supplierId === SUPPLIER_ID,
      );
      expect(supplierOne?.totalOriginal).toBe('100.00');
      expect(supplierOne?.totalPaid).toBe('40.00');
      expect(supplierOne?.totalPending).toBe('60.00');
      expect(result.grandTotal.invoiceCount).toBe(2);
      expect(result.grandTotal.totalOriginal).toBe('150.00');
      expect(result.grandTotal.totalPending).toBe('110.00');
    });
  });

  describe('getAging', () => {
    function makeAgingInvoice(
      dueDate: string | null,
      totalAmount: string,
      overrides: Partial<Record<string, unknown>> = {},
    ) {
      return makeInvoiceRow({
        dueDate: dueDate !== null ? new Date(`${dueDate}T00:00:00.000Z`) : null,
        totalAmount: d(totalAmount),
        ...overrides,
      });
    }

    it('sin dueDate: NO_DUE_DATE, nunca vencida automáticamente', async () => {
      prisma.tx.purchaseInvoice.findMany.mockResolvedValue([
        makeAgingInvoice(null, '100.00'),
      ]);
      const result = await service.getAging({}, RoleName.ADMIN);
      const bucket = result.totals.buckets.find(
        (b) => b.bucket === 'NO_DUE_DATE',
      );
      expect(bucket?.amount).toBe('100.00');
      expect(result.limitations.length).toBeGreaterThan(0);
    });

    it('agrupa por proveedor con porcentajes sobre el total pendiente de CADA proveedor', async () => {
      prisma.tx.purchaseInvoice.findMany.mockResolvedValue([
        makeAgingInvoice('2026-05-01', '100.00'), // vencida
        makeAgingInvoice(null, '50.00', { id: INVOICE_ID_2 }), // sin dueDate
      ]);
      const result = await service.getAging({}, RoleName.ADMIN);
      const supplier = result.bySupplier[0];
      expect(supplier.totalPending).toBe('150.00');
      const overdueBucket = supplier.buckets.find(
        (b) => b.bucket !== 'NO_DUE_DATE',
      );
      const noDueDateBucket = supplier.buckets.find(
        (b) => b.bucket === 'NO_DUE_DATE',
      );
      expect(noDueDateBucket?.percentage).toBe('33.33');
      expect(overdueBucket?.percentage).toBe('66.67');
    });
  });

  describe('getReconciliation', () => {
    it('factura CONFIRMED sin asiento (postedEntryId null): MISSING_ORIGINAL_ENTRY', async () => {
      prisma.tx.purchaseInvoice.findMany.mockResolvedValue([
        makeInvoiceRow({ postedEntryId: null }),
      ]);
      const result = await service.getReconciliation({}, RoleName.ADMIN);
      expect(result.invoices[0].discrepancies).toContain(
        'MISSING_ORIGINAL_ENTRY',
      );
      expect(result.overallConsistent).toBe(false);
    });

    it('asiento sin ninguna línea de crédito (0 líneas): INVALID_CREDIT_LINE_COUNT', async () => {
      prisma.tx.accountingEntryLine.findMany.mockResolvedValue([]);
      const result = await service.getReconciliation({}, RoleName.ADMIN);
      expect(result.invoices[0].discrepancies).toContain(
        'INVALID_CREDIT_LINE_COUNT',
      );
    });

    it('crédito distinto al totalAmount: CREDIT_AMOUNT_MISMATCH', async () => {
      prisma.tx.accountingEntryLine.findMany.mockResolvedValue([
        {
          entryId: ENTRY_ID,
          accountId: LIABILITY_ACCOUNT_ID,
          creditAmount: d('100.00'),
        },
      ]);
      const result = await service.getReconciliation({}, RoleName.ADMIN);
      expect(result.invoices[0].discrepancies).toContain(
        'CREDIT_AMOUNT_MISMATCH',
      );
      expect(result.overallConsistent).toBe(false);
    });

    it('todo consistente: sin discrepancias, overallConsistent=true', async () => {
      prisma.tx.accountingEntryLine.findMany.mockResolvedValue([
        {
          entryId: ENTRY_ID,
          accountId: LIABILITY_ACCOUNT_ID,
          creditAmount: d('150.00'),
        },
      ]);
      prisma.tx.supplierPaymentAllocation.groupBy.mockResolvedValue([
        { purchaseInvoiceId: INVOICE_ID, _sum: { amount: d('150.00') } },
      ]);
      prisma.tx.account.findMany.mockResolvedValue([
        { id: LIABILITY_ACCOUNT_ID, code: 'AP', name: 'Cuentas por pagar' },
      ]);
      prisma.tx.accountingEntryLine.groupBy.mockResolvedValue([
        {
          accountId: LIABILITY_ACCOUNT_ID,
          _sum: { debitAmount: d('150.00'), creditAmount: d('0.00') },
        },
      ]);

      const result = await service.getReconciliation({}, RoleName.ADMIN);

      expect(result.invoices[0].discrepancies).toEqual([]);
      expect(result.accounts[0].difference).toBe('0.00');
      expect(result.accounts[0].discrepancies).toEqual([]);
      expect(result.overallConsistent).toBe(true);
    });

    it('cuenta histórica con neto contable distinto al operativo: ACCOUNT_BALANCE_MISMATCH', async () => {
      prisma.tx.accountingEntryLine.findMany.mockResolvedValue([
        {
          entryId: ENTRY_ID,
          accountId: LIABILITY_ACCOUNT_ID,
          creditAmount: d('150.00'),
        },
      ]);
      prisma.tx.supplierPaymentAllocation.groupBy.mockResolvedValue([
        { purchaseInvoiceId: INVOICE_ID, _sum: { amount: d('150.00') } },
      ]);
      prisma.tx.account.findMany.mockResolvedValue([
        { id: LIABILITY_ACCOUNT_ID, code: 'AP', name: 'Cuentas por pagar' },
      ]);
      // Neto contable (100) distinto del operativo (150): discrepancia real.
      prisma.tx.accountingEntryLine.groupBy.mockResolvedValue([
        {
          accountId: LIABILITY_ACCOUNT_ID,
          _sum: { debitAmount: d('100.00'), creditAmount: d('0.00') },
        },
      ]);

      const result = await service.getReconciliation({}, RoleName.ADMIN);

      expect(result.accounts[0].discrepancies).toContain(
        'ACCOUNT_BALANCE_MISMATCH',
      );
      expect(result.overallConsistent).toBe(false);
    });

    it('conciliación de SOLO LECTURA: nunca escribe accountingEntry/supplierPayment', () => {
      expect(
        (prisma.tx as unknown as { accountingEntry?: unknown }).accountingEntry,
      ).toBeUndefined();
    });
  });

  describe('exportaciones Excel', () => {
    it('exportDetailedXlsx construye el workbook con las filas filtradas', async () => {
      await service.exportDetailedXlsx({}, RoleName.ADMIN);
      expect(excelExportService.assertWithinExportLimit).toHaveBeenCalled();
      expect(excelExportService.buildWorkbook).toHaveBeenCalledWith(
        'Cuentas por pagar',
        expect.anything(),
        expect.anything(),
      );
    });

    it('exportSummaryXlsx construye el workbook del resumen por proveedor', async () => {
      await service.exportSummaryXlsx({}, RoleName.ADMIN);
      expect(excelExportService.buildWorkbook).toHaveBeenCalledWith(
        'Resumen por proveedor',
        expect.anything(),
        expect.anything(),
      );
    });

    it('exportAgingXlsx construye el workbook de antigüedad de deuda', async () => {
      await service.exportAgingXlsx({}, RoleName.ADMIN);
      expect(excelExportService.buildWorkbook).toHaveBeenCalledWith(
        'Antigüedad de deuda',
        expect.anything(),
        expect.anything(),
      );
    });

    it('exportReconciliationXlsx construye el workbook de la conciliación', async () => {
      await service.exportReconciliationXlsx({}, RoleName.ADMIN);
      expect(excelExportService.buildWorkbook).toHaveBeenCalledWith(
        'Conciliación CxP',
        expect.anything(),
        expect.anything(),
      );
    });
  });
});

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AccountsPayableService } from './accounts-payable.service';

const INVOICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUPPLIER_ID = '99999999-9999-4999-8999-999999999999';

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
    status: 'CONFIRMED',
    ...overrides,
  };
}

function createPrismaMock() {
  return {
    purchaseInvoice: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      count: jest.fn<Promise<number>, [unknown]>(),
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
    },
    supplierPaymentAllocation: {
      groupBy: jest.fn<Promise<unknown[]>, [unknown]>(),
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
  };
}

describe('AccountsPayableService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: AccountsPayableService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.purchaseInvoice.findMany.mockResolvedValue([makeInvoiceRow()]);
    prisma.purchaseInvoice.count.mockResolvedValue(1);
    prisma.purchaseInvoice.findUnique.mockResolvedValue(makeInvoiceRow());
    prisma.supplierPaymentAllocation.groupBy.mockResolvedValue([]);
    prisma.supplierPaymentAllocation.findMany.mockResolvedValue([]);
    service = new AccountsPayableService(prisma as unknown as PrismaService);
  });

  describe('permisos', () => {
    it.each([RoleName.SELLER, RoleName.WAREHOUSE])(
      '%s no puede leer',
      async (role) => {
        await expect(service.list({}, role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(
          service.getDetail(INVOICE_ID, role),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );

    it.each([RoleName.ADMIN, RoleName.MANAGEMENT, RoleName.ACCOUNTANT])(
      '%s puede leer',
      async (role) => {
        await expect(service.list({}, role)).resolves.toBeDefined();
      },
    );
  });

  describe('list', () => {
    it('filtra siempre por status=CONFIRMED', async () => {
      await service.list({}, RoleName.ADMIN);
      const call = prisma.purchaseInvoice.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where.status).toBe('CONFIRMED');
    });

    it('sin pagos ACTIVE: paidAmount=0.00, balanceDue=totalAmount, status=UNPAID', async () => {
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.data[0].paidAmount).toBe('0.00');
      expect(result.data[0].balanceDue).toBe('150.00');
      expect(result.data[0].status).toBe('UNPAID');
    });

    it('con pago ACTIVE parcial: balanceDue/status recalculados desde la agregación', async () => {
      prisma.supplierPaymentAllocation.groupBy.mockResolvedValue([
        { purchaseInvoiceId: INVOICE_ID, _sum: { amount: d('50.00') } },
      ]);
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.data[0].paidAmount).toBe('50.00');
      expect(result.data[0].balanceDue).toBe('100.00');
      expect(result.data[0].status).toBe('PARTIALLY_PAID');
    });

    it('pago ACTIVE que cubre el total: status=PAID', async () => {
      prisma.supplierPaymentAllocation.groupBy.mockResolvedValue([
        { purchaseInvoiceId: INVOICE_ID, _sum: { amount: d('150.00') } },
      ]);
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.data[0].status).toBe('PAID');
    });
  });

  describe('getDetail', () => {
    it('factura inexistente: NotFoundException', async () => {
      prisma.purchaseInvoice.findUnique.mockResolvedValue(null);
      await expect(
        service.getDetail(INVOICE_ID, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('factura DRAFT/CANCELLED: NotFoundException (nunca es una cuenta por pagar)', async () => {
      prisma.purchaseInvoice.findUnique.mockResolvedValue(
        makeInvoiceRow({ status: 'DRAFT' }),
      );
      await expect(
        service.getDetail(INVOICE_ID, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('incluye historial de pagos ACTIVE y CANCELLED, pero el saldo solo cuenta los ACTIVE', async () => {
      prisma.supplierPaymentAllocation.groupBy.mockResolvedValue([
        { purchaseInvoiceId: INVOICE_ID, _sum: { amount: d('50.00') } },
      ]);
      prisma.supplierPaymentAllocation.findMany.mockResolvedValue([
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
});

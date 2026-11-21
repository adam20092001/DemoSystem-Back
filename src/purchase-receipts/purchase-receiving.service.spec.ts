import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PurchaseInvoiceStatus, RoleName } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PurchaseReceivingService } from './purchase-receiving.service';

const INVOICE_ID = '99999999-9999-4999-8999-999999999999';
const LINE_ID_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LINE_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';
const PRODUCT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUPPLIER = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  legalName: 'Importaciones Acme S.A.C.',
  tradeName: null,
};

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function createPrismaMock() {
  return {
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>(),
    purchaseInvoice: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    purchaseReceiptLine: {
      groupBy: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
  };
}

function makeInvoiceDetailRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    status: PurchaseInvoiceStatus.CONFIRMED,
    documentType: 'FACTURA',
    documentSeries: 'F001',
    documentNumber: '123',
    issueDate: new Date('2026-11-20T00:00:00.000Z'),
    supplier: SUPPLIER,
    lines: [
      {
        id: LINE_ID_1,
        quantity: d('10.000'),
        unitCodeSnapshot: 'UND',
        unitNameSnapshot: 'Unidad',
        product: { id: PRODUCT_ID, sku: 'SKU-1', name: 'Producto 1' },
      },
      {
        id: LINE_ID_2,
        quantity: d('5.000'),
        unitCodeSnapshot: null,
        unitNameSnapshot: null,
        product: { id: 'product-2', sku: 'SKU-2', name: 'Producto 2' },
      },
    ],
    ...overrides,
  };
}

describe('PurchaseReceivingService (R1)', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: PurchaseReceivingService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new PurchaseReceivingService(prisma as unknown as PrismaService);
  });

  describe('permisos', () => {
    it.each([RoleName.SELLER, RoleName.PURCHASING])(
      '%s: lista y detalle lanzan ForbiddenException sin tocar Prisma',
      async (role) => {
        await expect(
          service.listReceivableInvoices({}, role),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.findReceivableInvoice(INVOICE_ID, role),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(prisma.purchaseInvoice.findUnique).not.toHaveBeenCalled();
      },
    );

    it.each([
      RoleName.ADMIN,
      RoleName.WAREHOUSE,
      RoleName.MANAGEMENT,
      RoleName.ACCOUNTANT,
    ])('%s: puede listar y consultar el detalle', async (role) => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0n }]);
      await expect(
        service.listReceivableInvoices({}, role),
      ).resolves.toBeDefined();
      prisma.purchaseInvoice.findUnique.mockResolvedValue(
        makeInvoiceDetailRow(),
      );
      prisma.purchaseReceiptLine.groupBy.mockResolvedValue([]);
      await expect(
        service.findReceivableInvoice(INVOICE_ID, role),
      ).resolves.toBeDefined();
    });
  });

  describe('listReceivableInvoices', () => {
    it('sin facturas pendientes: página vacía, sin consultar el detalle', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0n }]);
      const result = await service.listReceivableInvoices(
        {},
        RoleName.WAREHOUSE,
      );
      expect(result).toEqual({
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
      expect(prisma.purchaseInvoice.findMany).not.toHaveBeenCalled();
    });

    it('devuelve identificación + líneas pendientes, conservando el orden de la consulta y SIN ningún campo financiero', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { id: 'inv-b', pendingLinesCount: 2 },
          { id: 'inv-a', pendingLinesCount: 1 },
        ])
        .mockResolvedValueOnce([{ total: 2n }]);
      const row = (id: string, number: string) => ({
        id,
        documentType: 'FACTURA',
        documentSeries: 'F001',
        documentNumber: number,
        issueDate: new Date('2026-11-20T00:00:00.000Z'),
        supplier: SUPPLIER,
      });
      prisma.purchaseInvoice.findMany.mockResolvedValue([
        row('inv-a', '1'),
        row('inv-b', '2'),
      ]);

      const result = await service.listReceivableInvoices(
        { page: 1, limit: 10 },
        RoleName.WAREHOUSE,
      );

      expect(result.data.map((i) => i.id)).toEqual(['inv-b', 'inv-a']);
      expect(result.data[0]).toEqual({
        id: 'inv-b',
        documentType: 'FACTURA',
        documentSeries: 'F001',
        documentNumber: '2',
        issueDate: '2026-11-20',
        supplier: SUPPLIER,
        pendingLinesCount: 2,
      });
      expect(result.total).toBe(2);
      expect(result.totalPages).toBe(1);

      const select = (
        prisma.purchaseInvoice.findMany.mock.calls[0][0] as {
          select: Record<string, unknown>;
        }
      ).select;
      for (const forbidden of [
        'subtotal',
        'taxAmount',
        'totalAmount',
        'postedEntryId',
        'lines',
      ]) {
        expect(select).not.toHaveProperty(forbidden);
      }
    });

    it('limita limit a 100 y calcula el offset de la página', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 250n }]);
      const result = await service.listReceivableInvoices(
        { page: 3, limit: 5000 },
        RoleName.ADMIN,
      );
      expect(result.limit).toBe(100);
      expect(result.page).toBe(3);
      expect(result.totalPages).toBe(3);
    });
  });

  describe('findReceivableInvoice', () => {
    it('factura inexistente: NotFoundException', async () => {
      prisma.purchaseInvoice.findUnique.mockResolvedValue(null);
      await expect(
        service.findReceivableInvoice(INVOICE_ID, RoleName.WAREHOUSE),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([PurchaseInvoiceStatus.DRAFT, PurchaseInvoiceStatus.CANCELLED])(
      'factura %s: ConflictException (solo CONFIRMED admite recepción)',
      async (status) => {
        prisma.purchaseInvoice.findUnique.mockResolvedValue(
          makeInvoiceDetailRow({ status }),
        );
        await expect(
          service.findReceivableInvoice(INVOICE_ID, RoleName.WAREHOUSE),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.purchaseReceiptLine.groupBy).not.toHaveBeenCalled();
      },
    );

    it('recepción parcial: cantidades facturada/recibida/pendiente por línea y estado', async () => {
      prisma.purchaseInvoice.findUnique.mockResolvedValue(
        makeInvoiceDetailRow(),
      );
      prisma.purchaseReceiptLine.groupBy.mockResolvedValue([
        { purchaseInvoiceLineId: LINE_ID_1, _sum: { quantity: d('4.000') } },
        { purchaseInvoiceLineId: LINE_ID_2, _sum: { quantity: d('5.000') } },
      ]);

      const result = await service.findReceivableInvoice(
        INVOICE_ID,
        RoleName.WAREHOUSE,
      );

      expect(result.lines).toEqual([
        {
          purchaseInvoiceLineId: LINE_ID_1,
          productId: PRODUCT_ID,
          productSku: 'SKU-1',
          productName: 'Producto 1',
          unitCode: 'UND',
          unitName: 'Unidad',
          invoicedQuantity: '10.000',
          receivedQuantity: '4.000',
          pendingQuantity: '6.000',
          status: 'PARTIAL',
        },
        {
          purchaseInvoiceLineId: LINE_ID_2,
          productId: 'product-2',
          productSku: 'SKU-2',
          productName: 'Producto 2',
          unitCode: null,
          unitName: null,
          invoicedQuantity: '5.000',
          receivedQuantity: '5.000',
          pendingQuantity: '0.000',
          status: 'COMPLETE',
        },
      ]);
      expect(result.pendingLinesCount).toBe(1);
    });

    it('solo cuenta recepciones ACTIVE (el filtro viaja en el groupBy) y solo líneas elegibles', async () => {
      prisma.purchaseInvoice.findUnique.mockResolvedValue(
        makeInvoiceDetailRow(),
      );
      prisma.purchaseReceiptLine.groupBy.mockResolvedValue([]);
      await service.findReceivableInvoice(INVOICE_ID, RoleName.WAREHOUSE);

      const groupBy = prisma.purchaseReceiptLine.groupBy.mock.calls[0][0] as {
        where: { purchaseReceipt: { status: string } };
      };
      expect(groupBy.where.purchaseReceipt.status).toBe('ACTIVE');
      const invoiceQuery = prisma.purchaseInvoice.findUnique.mock
        .calls[0][0] as {
        select: { lines: { where: { isReceiptEligible: boolean } } };
      };
      expect(invoiceQuery.select.lines.where.isReceiptEligible).toBe(true);
    });

    it('la respuesta NO contiene montos ni identificadores contables (ni en la consulta ni en el resultado)', async () => {
      prisma.purchaseInvoice.findUnique.mockResolvedValue(
        makeInvoiceDetailRow(),
      );
      prisma.purchaseReceiptLine.groupBy.mockResolvedValue([]);
      const result = await service.findReceivableInvoice(
        INVOICE_ID,
        RoleName.WAREHOUSE,
      );

      const serialized = JSON.stringify(result);
      for (const forbidden of [
        'unitCost',
        'taxableBase',
        'taxAmount',
        'creditable',
        'lineTotal',
        'totalAmount',
        'subtotal',
        'postedEntryId',
        'reclassif',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }

      const select = (
        prisma.purchaseInvoice.findUnique.mock.calls[0][0] as {
          select: {
            lines: { select: Record<string, unknown> };
          } & Record<string, unknown>;
        }
      ).select;
      expect(Object.keys(select.lines.select).sort()).toEqual(
        [
          'id',
          'product',
          'quantity',
          'unitCodeSnapshot',
          'unitNameSnapshot',
        ].sort(),
      );
      for (const forbidden of ['subtotal', 'totalAmount', 'postedEntryId']) {
        expect(select).not.toHaveProperty(forbidden);
      }
    });
  });
});

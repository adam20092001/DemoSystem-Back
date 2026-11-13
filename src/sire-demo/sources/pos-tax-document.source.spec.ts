/* eslint-disable @typescript-eslint/no-unsafe-assignment -- los matchers asimétricos de Jest (expect.objectContaining) devuelven any */
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { dec } from '../core/test-helpers';
import { PosTaxDocumentSource } from './pos-tax-document.source';

function build() {
  const prisma = {
    $queryRaw: jest.fn<Promise<unknown>, [Prisma.Sql]>(),
    $transaction: jest.fn((ops: Promise<unknown>[], options?: unknown) => {
      void options;
      return Promise.all(ops);
    }),
    electronicDocument: { findMany: jest.fn(), count: jest.fn() },
    sale: { count: jest.fn() },
    purchaseInvoice: { findMany: jest.fn(), count: jest.fn() },
  };
  return {
    prisma,
    source: new PosTaxDocumentSource(prisma as unknown as PrismaService),
  };
}

describe('PosTaxDocumentSource (solo lectura)', () => {
  it('RVIE: lee ACCEPTED del mes en America/Lima, cuenta excluidos y ventas sin comprobante en UNA transacción REPEATABLE READ', async () => {
    const { prisma, source } = build();
    prisma.electronicDocument.findMany.mockResolvedValue([
      {
        id: 'id-1',
        documentType: 'FACTURA',
        series: 'F001',
        number: 7,
        status: 'ACCEPTED',
        providerCode: 'MOCK',
        issuedAt: new Date('2026-01-05T15:00:00.000Z'),
        currencyCode: 'PEN',
        customerDocumentType: 'RUC',
        customerDocumentNumber: '99999000001',
        customerName: 'DEMO',
        taxableBase: dec('847.46'),
        taxAmount: dec('152.54'),
        total: dec('1000.00'),
      },
    ]);
    prisma.electronicDocument.count.mockResolvedValue(3);
    prisma.sale.count.mockResolvedValue(2);

    const result = await source.load('RVIE', '202601');

    // Enero en Lima: [2026-01-01T05:00Z, 2026-02-01T05:00Z)
    const range = {
      gte: new Date('2026-01-01T05:00:00.000Z'),
      lt: new Date('2026-02-01T05:00:00.000Z'),
    };
    expect(prisma.electronicDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'ACCEPTED', issuedAt: range },
      }),
    );
    expect(prisma.electronicDocument.count).toHaveBeenCalledWith({
      where: { status: { not: 'ACCEPTED' }, issuedAt: range },
    });
    expect(prisma.sale.count).toHaveBeenCalledWith({
      where: {
        status: 'ACTIVE',
        confirmedAt: range,
        electronicDocuments: { none: {} },
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(result.excluded).toEqual({
      notEligibleStatus: 3,
      salesWithoutFiscalDocument: 2,
    });
    expect(result.documents).toEqual([
      expect.objectContaining({
        register: 'RVIE',
        refId: 'id-1',
        number: 7,
        providerCode: 'MOCK',
      }),
    ]);
  });

  it('RCE: lee CONFIRMED por accountingDate del mes (fechas de calendario) y mapea al proveedor', async () => {
    const { prisma, source } = build();
    prisma.purchaseInvoice.findMany.mockResolvedValue([
      {
        id: 'pi-1',
        documentType: 'FACTURA',
        documentSeries: null,
        documentNumber: '00000101',
        status: 'CONFIRMED',
        issueDate: new Date('2025-12-28T00:00:00.000Z'),
        accountingDate: new Date('2026-02-03T00:00:00.000Z'),
        currencyCode: 'PEN',
        subtotal: dec('847.46'),
        taxAmount: dec('152.54'),
        totalAmount: dec('1000.00'),
        supplier: {
          documentType: 'RUC',
          documentNumber: '99999100001',
          legalName: 'DEMO PROVEEDOR',
        },
      },
    ]);
    prisma.purchaseInvoice.count.mockResolvedValue(4);

    const result = await source.load('RCE', '202602');

    const accountingDate = {
      gte: new Date('2026-02-01T00:00:00.000Z'),
      lte: new Date('2026-02-28T00:00:00.000Z'),
    };
    expect(prisma.purchaseInvoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'CONFIRMED', accountingDate },
      }),
    );
    expect(prisma.purchaseInvoice.count).toHaveBeenCalledWith({
      where: { status: { not: 'CONFIRMED' }, accountingDate },
    });
    expect(result.excluded).toEqual({
      notEligibleStatus: 4,
      salesWithoutFiscalDocument: null,
    });
    expect(result.documents[0]).toMatchObject({
      register: 'RCE',
      refId: 'pi-1',
      supplierDocumentNumber: '99999100001',
      supplierLegalName: 'DEMO PROVEEDOR',
    });
    expect(prisma.sale.count).not.toHaveBeenCalled();
  });

  it('febrero bisiesto: el último día es el 29', async () => {
    const { prisma, source } = build();
    prisma.purchaseInvoice.findMany.mockResolvedValue([]);
    prisma.purchaseInvoice.count.mockResolvedValue(0);
    await source.load('RCE', '202402');
    expect(prisma.purchaseInvoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          accountingDate: {
            gte: new Date('2024-02-01T00:00:00.000Z'),
            lte: new Date('2024-02-29T00:00:00.000Z'),
          },
        }),
      }),
    );
  });

  it('listPeriods: SQL de solo lectura, con conversión a America/Lima y estados elegibles', async () => {
    const { prisma, source } = build();
    prisma.$queryRaw.mockResolvedValueOnce([
      { period: '202603', documentCount: BigInt(5) },
    ]);
    prisma.$queryRaw.mockResolvedValueOnce([
      { period: '202604', documentCount: 2 },
    ]);

    expect(await source.listPeriods('RVIE')).toEqual([
      { period: '202603', documentCount: 5 },
    ]);
    expect(await source.listPeriods('RCE')).toEqual([
      { period: '202604', documentCount: 2 },
    ]);

    const [rvieSql, rceSql] = prisma.$queryRaw.mock.calls.map(
      (call) => call[0],
    );
    expect(rvieSql.sql).toContain("AT TIME ZONE 'America/Lima'");
    expect(rvieSql.sql).toContain('FROM electronic_documents');
    expect(rvieSql.values).toEqual(['ACCEPTED']);
    expect(rceSql.sql).toContain('FROM purchase_invoices');
    expect(rceSql.values).toEqual(['CONFIRMED']);
    for (const sql of [rvieSql.sql, rceSql.sql]) {
      expect(sql).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i,
      );
    }
  });

  it('el doble de Prisma no expone escrituras: cualquier intento de escribir fallaría', () => {
    const { prisma } = build();
    expect(Object.keys(prisma.electronicDocument)).toEqual([
      'findMany',
      'count',
    ]);
    expect(Object.keys(prisma.purchaseInvoice)).toEqual(['findMany', 'count']);
    expect(Object.keys(prisma.sale)).toEqual(['count']);
  });
});

import {
  CustomerType,
  Prisma,
  SaleDeliveryStatus,
  SalePaymentStatus,
  SaleStatus,
} from '@prisma/client';
import { SaleDetailRow, toSafeSale } from './sale.mapper';

function item(lineTotal: string) {
  return {
    id: `sale-item-${lineTotal}`,
    productId: 'product-1',
    productSku: 'SKU-1',
    productName: 'Producto',
    unitCode: 'UND',
    unitName: 'Unidad',
    unitAbbreviation: 'und',
    quantity: new Prisma.Decimal('1.000'),
    unitPrice: new Prisma.Decimal(lineTotal),
    lineTotal: new Prisma.Decimal(lineTotal),
    // NR-03: sin descuento de línea por defecto en este fixture.
    discountType: null,
    discountValue: null,
    discountAmount: new Prisma.Decimal('0'),
  };
}

function makeRow(overrides: Partial<SaleDetailRow>): SaleDetailRow {
  return {
    id: 'sale-1',
    number: 'NV-000001',
    status: SaleStatus.ACTIVE,
    paymentStatus: SalePaymentStatus.UNPAID,
    deliveryStatus: SaleDeliveryStatus.NOT_APPLICABLE,
    customerId: 'customer-1',
    customerIsGeneric: false,
    customerType: CustomerType.PERSON,
    customerDocumentType: null,
    customerDocumentNumber: null,
    customerName: 'Cliente',
    customerAddress: null,
    seller: {
      id: 'seller-1',
      username: 'seller',
      firstName: 'Ana',
      lastName: 'Vendedora',
    },
    quote: null,
    subtotal: new Prisma.Decimal('0'),
    discountAmount: new Prisma.Decimal('0'),
    taxAmount: new Prisma.Decimal('0'),
    total: new Prisma.Decimal('0'),
    currencyCode: 'PEN',
    taxEnabled: true,
    taxRate: new Prisma.Decimal('18.00'),
    pricesIncludeTax: true,
    paidAmount: new Prisma.Decimal('0'),
    balanceDue: new Prisma.Decimal('0'),
    items: [],
    payments: [],
    confirmedAt: new Date('2026-03-15T12:00:00.000Z'),
    cancelledAt: null,
    cancellationReason: null,
    cancelledBy: null,
    createdAt: new Date('2026-03-15T12:00:00.000Z'),
    updatedAt: new Date('2026-03-15T12:00:00.000Z'),
    ...overrides,
  };
}

describe('toSafeSale — campos derivados de R2-B4', () => {
  it('venta con IGV incluido: 118.00 con descuento al cliente 11.80', () => {
    const result = toSafeSale(
      makeRow({
        pricesIncludeTax: true,
        subtotal: new Prisma.Decimal('100.00'),
        discountAmount: new Prisma.Decimal('10.00'),
        taxAmount: new Prisma.Decimal('16.20'),
        total: new Prisma.Decimal('106.20'),
        balanceDue: new Prisma.Decimal('106.20'),
        items: [item('118.00')],
      }),
      [],
    );

    expect(result).toMatchObject({
      pricesIncludeTax: true,
      itemsTotal: '118.00',
      customerDiscountAmount: '11.80',
      taxableBase: '90.00',
      subtotal: '100.00',
      discountAmount: '10.00',
      taxAmount: '16.20',
      total: '106.20',
    });
  });

  it('venta con IGV incluido y varias líneas: itemsTotal = Σ lineTotal, sin descuento', () => {
    const result = toSafeSale(
      makeRow({
        subtotal: new Prisma.Decimal('211.86'),
        taxAmount: new Prisma.Decimal('38.14'),
        total: new Prisma.Decimal('250.00'),
        items: [item('118.00'), item('132.00')],
      }),
      [],
    );
    expect(result.itemsTotal).toBe('250.00');
    expect(result.customerDiscountAmount).toBe('0.00');
    expect(result.taxableBase).toBe('211.86');
  });

  it('venta HISTÓRICA: el descuento al cliente es el discountAmount persistido (nunca itemsTotal - total)', () => {
    const result = toSafeSale(
      makeRow({
        pricesIncludeTax: false,
        subtotal: new Prisma.Decimal('100.00'),
        discountAmount: new Prisma.Decimal('10.00'),
        taxAmount: new Prisma.Decimal('16.20'),
        total: new Prisma.Decimal('106.20'),
        items: [item('100.00')],
      }),
      [],
    );

    expect(result).toMatchObject({
      pricesIncludeTax: false,
      itemsTotal: '100.00',
      customerDiscountAmount: '10.00',
      taxableBase: '90.00',
      subtotal: '100.00',
      discountAmount: '10.00',
      taxAmount: '16.20',
      total: '106.20',
    });
  });

  it('no muta la fila recibida', () => {
    const row = makeRow({
      total: new Prisma.Decimal('10.00'),
      items: [item('10.00')],
    });
    const before = JSON.stringify(row);
    toSafeSale(row, []);
    expect(JSON.stringify(row)).toBe(before);
  });
});

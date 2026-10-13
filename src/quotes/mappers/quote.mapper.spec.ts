import { CustomerType, Prisma, QuoteStatus } from '@prisma/client';
import { QuoteDetailRow, toSafeQuote } from './quote.mapper';

const BUSINESS_DATE = '2026-03-15';

function item(lineTotal: string) {
  return {
    id: `item-${lineTotal}`,
    productId: 'product-1',
    productSku: 'SKU-1',
    productName: 'Producto',
    unitCode: 'UND',
    unitName: 'Unidad',
    unitAbbreviation: 'und',
    quantity: new Prisma.Decimal('1'),
    unitPrice: new Prisma.Decimal(lineTotal),
    lineTotal: new Prisma.Decimal(lineTotal),
    product: {
      stockCurrent: new Prisma.Decimal('10.000'),
      isInventoryTracked: false,
    },
  };
}

function makeRow(overrides: Partial<QuoteDetailRow>): QuoteDetailRow {
  return {
    id: 'quote-1',
    number: 'COT-000001',
    status: QuoteStatus.PENDING,
    customerId: 'customer-1',
    customerType: CustomerType.PERSON,
    customerDocumentType: null,
    customerDocumentNumber: null,
    customerName: 'Cliente',
    customerAddress: null,
    sellerId: 'seller-1',
    seller: {
      id: 'seller-1',
      username: 'seller',
      firstName: 'Ana',
      lastName: 'Vendedora',
    },
    issueDate: new Date('2026-03-15T00:00:00.000Z'),
    expirationDate: new Date('2026-03-30T00:00:00.000Z'),
    subtotal: new Prisma.Decimal('0'),
    discountAmount: new Prisma.Decimal('0'),
    taxAmount: new Prisma.Decimal('0'),
    total: new Prisma.Decimal('0'),
    currencyCode: 'PEN',
    taxEnabled: true,
    taxRate: new Prisma.Decimal('18.00'),
    pricesIncludeTax: true,
    notes: null,
    items: [],
    createdAt: new Date('2026-03-15T00:00:00.000Z'),
    updatedAt: new Date('2026-03-15T00:00:00.000Z'),
    ...overrides,
  };
}

describe('toSafeQuote — campos derivados de R2-B3', () => {
  it('cotización con IGV incluido: 118.00 con descuento al cliente 11.80', () => {
    const result = toSafeQuote(
      makeRow({
        pricesIncludeTax: true,
        subtotal: new Prisma.Decimal('100.00'),
        discountAmount: new Prisma.Decimal('10.00'),
        taxAmount: new Prisma.Decimal('16.20'),
        total: new Prisma.Decimal('106.20'),
        items: [item('118.00')],
      }),
      BUSINESS_DATE,
    );

    expect(result).toMatchObject({
      pricesIncludeTax: true,
      itemsTotal: '118.00',
      customerDiscountAmount: '11.80',
      taxableBase: '90.00',
      // Campos existentes intactos: discountAmount sigue siendo el
      // persistido antes de impuesto.
      subtotal: '100.00',
      discountAmount: '10.00',
      taxAmount: '16.20',
      total: '106.20',
    });
  });

  it('cotización con IGV incluido y varias líneas: itemsTotal = Σ lineTotal', () => {
    const result = toSafeQuote(
      makeRow({
        subtotal: new Prisma.Decimal('108.47'),
        taxAmount: new Prisma.Decimal('19.53'),
        total: new Prisma.Decimal('128.00'),
        items: [item('118.00'), item('10.00')],
      }),
      BUSINESS_DATE,
    );
    expect(result.itemsTotal).toBe('128.00');
    expect(result.customerDiscountAmount).toBe('0.00');
    expect(result.taxableBase).toBe('108.47');
  });

  it('cotización HISTÓRICA: el descuento al cliente es el discountAmount persistido (nunca itemsTotal - total)', () => {
    // Histórica al 18%: línea 100.00 antes de impuesto, descuento 10.00,
    // IGV sumado 16.20 sobre 90.00, total 106.20.
    const result = toSafeQuote(
      makeRow({
        pricesIncludeTax: false,
        subtotal: new Prisma.Decimal('100.00'),
        discountAmount: new Prisma.Decimal('10.00'),
        taxAmount: new Prisma.Decimal('16.20'),
        total: new Prisma.Decimal('106.20'),
        items: [item('100.00')],
      }),
      BUSINESS_DATE,
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
    toSafeQuote(row, BUSINESS_DATE);
    expect(JSON.stringify(row)).toBe(before);
  });
});

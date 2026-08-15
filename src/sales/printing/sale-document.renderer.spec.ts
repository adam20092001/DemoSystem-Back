import {
  CustomerDocumentType,
  CustomerType,
  SaleDeliveryStatus,
  SalePaymentStatus,
  SaleStatus,
} from '@prisma/client';
import { SafeSale } from '../types/safe-sale';
import { SaleDocumentRenderer } from './sale-document.renderer';

function makeSale(overrides: Partial<SafeSale> = {}): SafeSale {
  return {
    id: 'sale-1',
    number: 'NV-000001',
    status: SaleStatus.ACTIVE,
    paymentStatus: SalePaymentStatus.UNPAID,
    deliveryStatus: SaleDeliveryStatus.PENDING,
    customerId: 'customer-1',
    customerIsGeneric: false,
    customerType: CustomerType.PERSON,
    customerDocumentType: null,
    customerDocumentNumber: null,
    customerName: 'Cliente Uno',
    customerAddress: null,
    seller: {
      id: 'seller-1',
      username: 'admin',
      firstName: 'Ana',
      lastName: 'Admin',
    },
    quote: null,
    subtotal: '10.00',
    discountAmount: '0.00',
    taxAmount: '0.00',
    total: '10.00',
    paidAmount: '0.00',
    balanceDue: '10.00',
    items: [
      {
        id: 'item-1',
        productId: 'product-1',
        productSku: 'SKU-1',
        productName: 'Producto Uno',
        unitCode: 'UND',
        unitName: 'Unidad',
        unitAbbreviation: 'und',
        quantity: '1.000',
        unitPrice: '10.00',
        lineTotal: '10.00',
      },
    ],
    inventoryMovements: [
      {
        id: 'movement-1',
        productId: 'product-1',
        movementType: 'EXIT',
        origin: 'SALE',
        quantity: '1.000',
        previousStock: '50.000',
        newStock: '49.000',
        createdAt: new Date('2026-03-15T00:00:00.000Z'),
      },
    ],
    payments: [],
    confirmedAt: new Date('2026-03-15T15:30:00.000Z'),
    cancelledAt: null,
    cancellationReason: null,
    cancelledBy: null,
    createdAt: new Date('2026-03-15T15:30:00.000Z'),
    updatedAt: new Date('2026-03-15T15:30:00.000Z'),
    ...overrides,
  };
}

describe('SaleDocumentRenderer', () => {
  const renderer = new SaleDocumentRenderer();

  it('genera HTML no vacío con apariencia válida', () => {
    const html = renderer.render(makeSale());
    expect(html.length).toBeGreaterThan(0);
    expect(html).toMatch(/<html/i);
    expect(html).toMatch(/<\/html>/i);
  });

  it('muestra la leyenda DOCUMENTO INTERNO — NO FISCAL', () => {
    const html = renderer.render(makeSale());
    expect(html).toContain('DOCUMENTO INTERNO');
    expect(html).toContain('NO FISCAL');
  });

  it('muestra el número NV', () => {
    const html = renderer.render(makeSale());
    expect(html).toContain('NV-000001');
  });

  it('muestra fecha de confirmación, estado y estado de entrega', () => {
    const html = renderer.render(makeSale());
    expect(html).toContain('2026-03-15T15:30:00.000Z');
    expect(html).toContain('ACTIVE');
    expect(html).toContain('PENDING');
  });

  it('muestra los totales', () => {
    const html = renderer.render(makeSale());
    expect(html).toContain('10.00');
  });

  it('venta normal (ACTIVE) NO muestra el aviso de anulada', () => {
    const html = renderer.render(makeSale());
    expect(html).not.toContain('ANULADA');
    expect(html).not.toContain('<div class="cancelled-banner">');
  });

  it('venta CANCELLED muestra visiblemente ANULADA / CANCELLED', () => {
    const html = renderer.render(makeSale({ status: SaleStatus.CANCELLED }));
    expect(html).toContain('ANULADA');
    expect(html).toContain('CANCELLED');
  });

  it('venta CANCELLED sigue mostrando el mismo número NV (no genera uno nuevo)', () => {
    const html = renderer.render(makeSale({ status: SaleStatus.CANCELLED }));
    expect(html).toContain('NV-000001');
  });

  it('referencia la cotización de origen cuando existe', () => {
    const html = renderer.render(
      makeSale({ quote: { id: 'quote-1', number: 'COT-000001' } }),
    );
    expect(html).toContain('COT-000001');
  });

  it('sin cotización de origen: no menciona ninguna referencia de cotización', () => {
    const html = renderer.render(makeSale({ quote: null }));
    expect(html).not.toContain('COT-');
  });

  it('cliente genérico (customerType null) no rompe el render', () => {
    expect(() =>
      renderer.render(
        makeSale({
          customerIsGeneric: true,
          customerType: null,
          customerName: 'Público general',
        }),
      ),
    ).not.toThrow();
  });

  it('maneja campos nulos opcionales sin lanzar (documento/dirección/cotización null)', () => {
    expect(() =>
      renderer.render(
        makeSale({
          customerDocumentType: null,
          customerDocumentNumber: null,
          customerAddress: null,
          quote: null,
        }),
      ),
    ).not.toThrow();
  });

  it('renderiza múltiples ítems', () => {
    const sale = makeSale({
      items: [
        makeSale().items[0],
        {
          ...makeSale().items[0],
          id: 'item-2',
          productSku: 'SKU-2',
          productName: 'Producto Dos',
        },
      ],
    });
    const html = renderer.render(sale);
    expect(html).toContain('SKU-1');
    expect(html).toContain('SKU-2');
  });

  describe('nunca renderiza datos de pago/inventario', () => {
    it('nunca menciona paidAmount/balanceDue/paymentStatus', () => {
      const html = renderer.render(makeSale());
      expect(html.toLowerCase()).not.toMatch(
        /paidamount|balancedue|paymentstatus/,
      );
      expect(html).not.toContain('0.00 pagado');
    });

    it('nunca renderiza movimientos de inventario ni stock', () => {
      const html = renderer.render(makeSale());
      expect(html.toLowerCase()).not.toMatch(
        /previousstock|newstock|movementtype|inventorymovement/,
      );
    });

    it('nunca renderiza el motivo de anulación en texto libre', () => {
      const html = renderer.render(
        makeSale({
          status: SaleStatus.CANCELLED,
          cancellationReason: 'Motivo interno confidencial del cliente',
        }),
      );
      expect(html).not.toContain('Motivo interno confidencial del cliente');
    });

    it('nunca expone campos de seguridad de cancelledBy', () => {
      const html = renderer.render(
        makeSale({
          status: SaleStatus.CANCELLED,
          cancelledBy: {
            id: 'admin-1',
            username: 'admin',
            firstName: 'Ana',
            lastName: 'Admin',
          },
        }),
      );
      expect(html.toLowerCase()).not.toMatch(/passwordhash|roleid/);
    });
  });

  describe('seguridad', () => {
    it('no contiene recursos externos http(s)://', () => {
      const html = renderer.render(makeSale());
      expect(html).not.toMatch(/https?:\/\//);
    });

    it('no contiene ninguna etiqueta <script', () => {
      const html = renderer.render(makeSale());
      expect(html.toLowerCase()).not.toContain('<script');
    });
  });

  describe('escapado HTML', () => {
    it('escapa <script>alert(1)</script> en el nombre de cliente: sin etiqueta ejecutable', () => {
      const html = renderer.render(
        makeSale({ customerName: '<script>alert(1)</script>' }),
      );
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('escapa & correctamente (A&B -> A&amp;B) en el nombre de cliente', () => {
      const html = renderer.render(makeSale({ customerName: 'A&B' }));
      expect(html).toContain('A&amp;B');
    });

    it('escapa comillas dobles en la dirección', () => {
      const html = renderer.render(
        makeSale({ customerAddress: '"Av. Principal" & Cía' }),
      );
      expect(html).toContain('&quot;Av. Principal&quot;');
      expect(html).toContain('&amp;');
    });

    it("escapa comillas simples (O'Brien) en el nombre de cliente", () => {
      const html = renderer.render(makeSale({ customerName: "O'Brien" }));
      expect(html).toContain('O&#39;Brien');
    });

    it('escapa < y > combinados en el número de venta', () => {
      const html = renderer.render(
        makeSale({ number: 'NV<script>x</script>' }),
      );
      expect(html).not.toContain('<script>x</script>');
      expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    });

    it('escapa el documento del cliente', () => {
      const html = renderer.render(
        makeSale({
          customerDocumentType: CustomerDocumentType.DNI,
          customerDocumentNumber: '<b>12345678</b>',
        }),
      );
      expect(html).not.toContain('<b>12345678</b>');
      expect(html).toContain('&lt;b&gt;12345678&lt;/b&gt;');
    });

    it('escapa los campos del vendedor', () => {
      const html = renderer.render(
        makeSale({
          seller: {
            id: 's',
            username: 'a<b',
            firstName: 'Ana"',
            lastName: "O'Neil",
          },
        }),
      );
      expect(html).toContain('&lt;b');
      expect(html).toContain('Ana&quot;');
      expect(html).toContain('O&#39;Neil');
    });

    it('escapa el número de cotización de origen', () => {
      const html = renderer.render(
        makeSale({ quote: { id: 'quote-1', number: 'COT<script>x</script>' } }),
      );
      expect(html).not.toContain('<script>x</script>');
      expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    });

    it('escapa SKU/nombre de producto inyectados', () => {
      const sale = makeSale();
      sale.items[0].productSku = '<img src=x onerror=alert(1)>';
      sale.items[0].productName = '"><script>alert(2)</script>';
      const html = renderer.render(sale);
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
      expect(html).not.toContain('<script>alert(2)</script>');
    });

    it('escapa unitCode/unitName/unitAbbreviation', () => {
      const sale = makeSale();
      sale.items[0].unitName = '<script>u()</script>';
      const html = renderer.render(sale);
      expect(html).not.toContain('<script>u()</script>');
    });
  });
});

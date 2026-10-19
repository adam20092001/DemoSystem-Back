import {
  CustomerDocumentType,
  CustomerType,
  QuoteStatus,
} from '@prisma/client';
import { SafeQuote } from '../types/safe-quote';
import { QuoteDocumentRenderer } from './quote-document.renderer';

function makeQuote(overrides: Partial<SafeQuote> = {}): SafeQuote {
  return {
    id: 'quote-1',
    number: 'COT-000001',
    status: QuoteStatus.PENDING,
    customerId: 'customer-1',
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
    issueDate: '2026-03-15',
    expirationDate: '2026-04-15',
    subtotal: '10.00',
    discountAmount: '0.00',
    taxAmount: '0.00',
    total: '10.00',
    currencyCode: 'PEN',
    taxEnabled: false,
    taxRate: '18.00',
    // Por defecto, cotización HISTÓRICA (formato original sin cambios).
    pricesIncludeTax: false,
    itemsTotal: '10.00',
    customerDiscountAmount: '0.00',
    taxableBase: '10.00',
    notes: null,
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
        discountType: null,
        discountValue: null,
        discountAmount: '0.00',
        stockInfo: {
          currentStock: '50.000',
          requestedQuantity: '1.000',
          sufficient: true,
        },
      },
    ],
    createdAt: new Date('2026-03-15T00:00:00.000Z'),
    updatedAt: new Date('2026-03-15T00:00:00.000Z'),
    ...overrides,
  };
}

describe('QuoteDocumentRenderer', () => {
  const renderer = new QuoteDocumentRenderer();

  it('genera HTML no vacío con apariencia válida', () => {
    const html = renderer.render(makeQuote());
    expect(html.length).toBeGreaterThan(0);
    expect(html).toMatch(/<html/i);
    expect(html).toMatch(/<\/html>/i);
  });

  it('escapa <script>alert(1)</script> en notes: sin etiqueta ejecutable', () => {
    const html = renderer.render(
      makeQuote({ notes: '<script>alert(1)</script>' }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapa & correctamente (A&B -> A&amp;B)', () => {
    const html = renderer.render(makeQuote({ customerName: 'A&B' }));
    expect(html).toContain('A&amp;B');
  });

  it('escapa comillas dobles ("quoted" -> &quot;quoted&quot;)', () => {
    const html = renderer.render(makeQuote({ notes: '"quoted"' }));
    expect(html).toContain('&quot;quoted&quot;');
  });

  it("escapa comillas simples (O'Brien -> O&#39;Brien)", () => {
    const html = renderer.render(makeQuote({ customerName: "O'Brien" }));
    expect(html).toContain('O&#39;Brien');
  });

  it('escapa combinaciones de < y >', () => {
    const html = renderer.render(
      makeQuote({ notes: '<b>bold</b> > 5 && < 10' }),
    );
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('&gt; 5');
  });

  it('escapa el snapshot de nombre de cliente inyectado con script', () => {
    const html = renderer.render(
      makeQuote({ customerName: '<script>evil()</script>' }),
    );
    expect(html).not.toContain('<script>evil()</script>');
  });

  it('escapa dirección y documento del cliente', () => {
    const html = renderer.render(
      makeQuote({
        customerDocumentType: CustomerDocumentType.DNI,
        customerDocumentNumber: '<b>12345678</b>',
        customerAddress: '"Av. Principal" & Cía',
      }),
    );
    expect(html).not.toContain('<b>12345678</b>');
    expect(html).toContain('&lt;b&gt;12345678&lt;/b&gt;');
    expect(html).toContain('&quot;Av. Principal&quot; &amp; C');
  });

  it('escapa SKU/nombre de producto inyectados', () => {
    const quote = makeQuote();
    quote.items[0].productSku = '<img src=x onerror=alert(1)>';
    quote.items[0].productName = '"><script>alert(2)</script>';
    const html = renderer.render(quote);
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>alert(2)</script>');
  });

  it('escapa unitCode/unitName/unitAbbreviation', () => {
    const quote = makeQuote();
    quote.items[0].unitName = '<script>u()</script>';
    const html = renderer.render(quote);
    expect(html).not.toContain('<script>u()</script>');
  });

  it('escapa los campos del vendedor', () => {
    const html = renderer.render(
      makeQuote({
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

  it('escapa el número de cotización', () => {
    const html = renderer.render(
      makeQuote({ number: 'COT<script>x</script>' }),
    );
    expect(html).not.toContain('<script>x</script>');
  });

  it('renderiza el nombre del cliente y los totales', () => {
    const html = renderer.render(makeQuote());
    expect(html).toContain('Cliente Uno');
    expect(html).toContain('10.00');
  });

  it('renderiza el número de cotización, fechas y estado', () => {
    const html = renderer.render(makeQuote());
    expect(html).toContain('COT-000001');
    expect(html).toContain('2026-03-15');
    expect(html).toContain('2026-04-15');
    expect(html).toContain('PENDING');
  });

  it('nunca renderiza stockInfo', () => {
    const html = renderer.render(makeQuote());
    expect(html).not.toMatch(/currentStock|requestedQuantity|sufficient/i);
  });

  it('maneja campos nulos opcionales sin lanzar (documento/dirección/notas null)', () => {
    expect(() =>
      renderer.render(
        makeQuote({
          customerDocumentType: null,
          customerDocumentNumber: null,
          customerAddress: null,
          notes: null,
        }),
      ),
    ).not.toThrow();
  });

  it('no contiene recursos externos http(s)://', () => {
    const html = renderer.render(makeQuote());
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('no contiene ninguna etiqueta <script', () => {
    const html = renderer.render(makeQuote());
    expect(html.toLowerCase()).not.toContain('<script');
  });

  it('renderiza múltiples ítems', () => {
    const quote = makeQuote({
      items: [
        makeQuote().items[0],
        {
          ...makeQuote().items[0],
          id: 'item-2',
          productSku: 'SKU-2',
          productName: 'Producto Dos',
        },
      ],
    });
    const html = renderer.render(quote);
    expect(html).toContain('SKU-1');
    expect(html).toContain('SKU-2');
  });

  describe('R2-B5 — presentación según la semántica de precios', () => {
    /** Cotización con precios finales al 18%: 118.00 con descuento al cliente 11.80. */
    function taxInclusiveQuote(overrides: Partial<SafeQuote> = {}): SafeQuote {
      const base = makeQuote();
      return makeQuote({
        pricesIncludeTax: true,
        taxEnabled: true,
        taxRate: '18.00',
        subtotal: '100.00',
        discountAmount: '10.00',
        taxAmount: '16.20',
        total: '106.20',
        itemsTotal: '118.00',
        customerDiscountAmount: '11.80',
        taxableBase: '90.00',
        items: [{ ...base.items[0], unitPrice: '118.00', lineTotal: '118.00' }],
        ...overrides,
      });
    }

    it('precios finales + IGV: rotula "inc. IGV", muestra descuento BRUTO, base e IGV contenido, y el total persistido', () => {
      const html = renderer.render(taxInclusiveQuote());
      expect(html).toContain('Precio unit. (inc. IGV)');
      expect(html).toContain('Total línea (inc. IGV)');
      expect(html).toContain('Total ítems: 118.00');
      expect(html).toContain('Descuento: 11.80');
      expect(html).toContain('Op. gravada: 90.00');
      expect(html).toContain('IGV (18%) incluido: 16.20');
      expect(html).toContain('Total a pagar: 106.20');
      // Nunca el descuento persistido antes de impuesto como si fuera el
      // descuento al cliente, ni el formato histórico.
      expect(html).not.toContain('Descuento: 10.00');
      expect(html).not.toContain('Subtotal:');
    });

    it('sin doble IGV: 118.00 al 18% sin descuento muestra total 118.00 (nunca 139.24)', () => {
      const html = renderer.render(
        taxInclusiveQuote({
          discountAmount: '0.00',
          subtotal: '100.00',
          taxAmount: '18.00',
          total: '118.00',
          customerDiscountAmount: '0.00',
          taxableBase: '100.00',
        }),
      );
      expect(html).toContain('IGV (18%) incluido: 18.00');
      expect(html).toContain('Total a pagar: 118.00');
      expect(html).not.toContain('139.24');
    });

    it('precios finales con IGV desactivado: etiqueta neutra, impuesto 0.00, sin base gravada ni "inc. IGV"', () => {
      const html = renderer.render(
        taxInclusiveQuote({
          taxEnabled: false,
          subtotal: '118.00',
          discountAmount: '0.00',
          taxAmount: '0.00',
          total: '118.00',
          customerDiscountAmount: '0.00',
          taxableBase: '118.00',
        }),
      );
      expect(html).toContain('Precio unit. final');
      expect(html).not.toContain('inc. IGV');
      expect(html).not.toContain('Op. gravada');
      expect(html).toContain('Impuesto: 0.00');
      expect(html).toContain('Total a pagar: 118.00');
    });

    it('tasa configurada distinta (10%) y descuento total', () => {
      const html = renderer.render(
        taxInclusiveQuote({
          taxRate: '10.00',
          subtotal: '100.00',
          discountAmount: '100.00',
          taxAmount: '0.00',
          total: '0.00',
          itemsTotal: '110.00',
          customerDiscountAmount: '110.00',
          taxableBase: '0.00',
        }),
      );
      expect(html).toContain('IGV (10%) incluido: 0.00');
      expect(html).toContain('Descuento: 110.00');
      expect(html).toContain('Total a pagar: 0.00');
    });

    it('cotización HISTÓRICA: formato y montos originales sin cambios', () => {
      const html = renderer.render(
        makeQuote({
          taxEnabled: true,
          subtotal: '100.00',
          discountAmount: '10.00',
          taxAmount: '16.20',
          total: '106.20',
          itemsTotal: '100.00',
          customerDiscountAmount: '10.00',
          taxableBase: '90.00',
        }),
      );
      expect(html).toContain('<th>Precio unit.</th>');
      expect(html).toContain('Subtotal: 100.00');
      expect(html).toContain('Descuento: 10.00');
      expect(html).toContain('Impuesto: 16.20');
      expect(html).toContain('Total: 106.20');
      expect(html).not.toContain('inc. IGV');
      expect(html).not.toContain('Total a pagar');
    });

    it('no muta el documento recibido', () => {
      const quote = taxInclusiveQuote();
      const before = JSON.stringify(quote);
      renderer.render(quote);
      expect(JSON.stringify(quote)).toBe(before);
    });
  });
});

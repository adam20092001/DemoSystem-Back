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
});

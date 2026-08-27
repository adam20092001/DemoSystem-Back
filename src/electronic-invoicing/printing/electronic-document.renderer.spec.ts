import {
  CustomerDocumentType,
  ElectronicDocumentStatus,
  FiscalDocumentType,
} from '@prisma/client';
import { SafeElectronicDocument } from '../types/safe-electronic-document';
import { ElectronicDocumentRenderer } from './electronic-document.renderer';

function makeDoc(
  overrides: Partial<SafeElectronicDocument> = {},
): SafeElectronicDocument {
  return {
    id: 'doc-1',
    saleId: 'sale-1',
    saleNumber: 'NV-000001',
    documentType: FiscalDocumentType.FACTURA,
    series: 'F001',
    number: 1,
    fullNumber: 'F001-00000001',
    status: ElectronicDocumentStatus.ACCEPTED,
    currencyCode: 'PEN',
    customerDocumentType: CustomerDocumentType.RUC,
    customerDocumentNumber: '20123456789',
    customerName: 'Distribuidora Uno SAC',
    subtotal: '100.00',
    discountAmount: '0.00',
    taxableBase: '100.00',
    taxAmount: '18.00',
    total: '118.00',
    providerCode: 'MOCK',
    providerStatus: 'ACCEPTED',
    issuedAt: new Date('2026-03-15T15:30:00.000Z'),
    lastSubmittedAt: new Date('2026-03-15T15:30:01.000Z'),
    acceptedAt: new Date('2026-03-15T15:30:02.000Z'),
    rejectedAt: null,
    createdAt: new Date('2026-03-15T15:30:00.000Z'),
    updatedAt: new Date('2026-03-15T15:30:02.000Z'),
    issuerTaxId: '20100000001',
    issuerBusinessName: 'Empresa Demo SAC',
    issuerAddress: 'Av. Principal 100',
    customerAddress: 'Av. Siempre Viva 123',
    providerMessage:
      'Documento aceptado por el proveedor de demostración (MOCK).',
    submissionCount: 1,
    items: [
      {
        lineNumber: 1,
        productSku: 'SKU-001',
        description: 'Producto Uno',
        unitCode: 'UND',
        unitName: 'Unidad',
        unitAbbreviation: 'und',
        quantity: '2.000',
        unitPrice: '50.00',
        lineTotal: '100.00',
      },
    ],
    ...overrides,
  };
}

describe('ElectronicDocumentRenderer', () => {
  const renderer = new ElectronicDocumentRenderer();

  it('genera HTML no vacío, documento HTML5 completo, sin script', () => {
    const html = renderer.render(makeDoc());
    expect(html.length).toBeGreaterThan(0);
    expect(html.toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html.toLowerCase()).not.toContain('<script');
  });

  it('no depende de PrismaService/SettingsReader/CustomerService/ProductsService (input es un objeto plano)', () => {
    // El constructor no recibe ninguna dependencia: prueba estructural de
    // independencia de datos en vivo (§33 del kickoff).
    expect(ElectronicDocumentRenderer.length).toBe(0);
  });

  describe('encabezado por tipo de documento', () => {
    it('FACTURA', () => {
      const html = renderer.render(
        makeDoc({ documentType: FiscalDocumentType.FACTURA }),
      );
      expect(html).toContain('FACTURA ELECTRÓNICA — DEMO');
    });

    it('BOLETA', () => {
      const html = renderer.render(
        makeDoc({ documentType: FiscalDocumentType.BOLETA }),
      );
      expect(html).toContain('BOLETA ELECTRÓNICA — DEMO');
    });
  });

  it('muestra fullNumber tal cual viene del snapshot, sin reformatear', () => {
    const html = renderer.render(makeDoc({ fullNumber: 'F001-00000042' }));
    expect(html).toContain('F001-00000042');
  });

  it('snapshot del emisor: businessName/taxId/address', () => {
    const html = renderer.render(
      makeDoc({
        issuerBusinessName: 'Emisor Demo SAC',
        issuerTaxId: '20999999999',
        issuerAddress: 'Calle Falsa 123',
      }),
    );
    expect(html).toContain('Emisor Demo SAC');
    expect(html).toContain('20999999999');
    expect(html).toContain('Calle Falsa 123');
  });

  it('snapshot del cliente: nombre, documento y dirección', () => {
    const html = renderer.render(
      makeDoc({
        customerName: 'Cliente Demo SAC',
        customerDocumentType: CustomerDocumentType.RUC,
        customerDocumentNumber: '20111111111',
        customerAddress: 'Jr. Demo 456',
      }),
    );
    expect(html).toContain('Cliente Demo SAC');
    expect(html).toContain('20111111111');
    expect(html).toContain('Jr. Demo 456');
  });

  it('cliente genérico (BOLETA): representación limpia "Público general", sin etiquetas de documento vacías', () => {
    const html = renderer.render(
      makeDoc({
        documentType: FiscalDocumentType.BOLETA,
        customerDocumentType: null,
        customerDocumentNumber: null,
        customerName: 'Público general',
        customerAddress: null,
      }),
    );
    expect(html).toContain('Público general');
    expect(html).not.toContain('<strong>Documento:</strong>');
  });

  it('tabla de ítems: columnas y valores del snapshot, sin recalcular', () => {
    const html = renderer.render(
      makeDoc({
        items: [
          {
            lineNumber: 1,
            productSku: 'SKU-A',
            description: 'Producto A',
            unitCode: 'UND',
            unitName: 'Unidad',
            unitAbbreviation: 'und',
            quantity: '3.000',
            unitPrice: '10.00',
            lineTotal: '30.00',
          },
        ],
      }),
    );
    expect(html).toContain('SKU-A');
    expect(html).toContain('Producto A');
    expect(html).toContain('3.000');
    expect(html).toContain('10.00');
    expect(html).toContain('30.00');
  });

  it('ordena los ítems por lineNumber ASC sin importar el orden de entrada', () => {
    const html = renderer.render(
      makeDoc({
        items: [
          {
            lineNumber: 2,
            productSku: 'SKU-B',
            description: 'Producto B',
            unitCode: 'UND',
            unitName: 'Unidad',
            unitAbbreviation: 'und',
            quantity: '1.000',
            unitPrice: '5.00',
            lineTotal: '5.00',
          },
          {
            lineNumber: 1,
            productSku: 'SKU-A',
            description: 'Producto A',
            unitCode: 'UND',
            unitName: 'Unidad',
            unitAbbreviation: 'und',
            quantity: '1.000',
            unitPrice: '5.00',
            lineTotal: '5.00',
          },
        ],
      }),
    );
    expect(html.indexOf('SKU-A')).toBeLessThan(html.indexOf('SKU-B'));
  });

  it('totales: subtotal, descuento, base imponible, IGV y total, todos del snapshot', () => {
    const html = renderer.render(
      makeDoc({
        subtotal: '250.00',
        discountAmount: '50.00',
        taxableBase: '200.00',
        taxAmount: '36.00',
        total: '236.00',
      }),
    );
    expect(html).toContain('250.00');
    expect(html).toContain('50.00');
    expect(html).toContain('200.00');
    expect(html).toContain('36.00');
    expect(html).toContain('236.00');
  });

  it('descuento 0 igual se muestra (transparencia)', () => {
    const html = renderer.render(makeDoc({ discountAmount: '0.00' }));
    expect(html).toContain('Descuento: 0.00');
  });

  describe('estado del proveedor', () => {
    it('muestra providerCode/providerStatus/status', () => {
      const html = renderer.render(
        makeDoc({
          providerCode: 'MOCK',
          providerStatus: 'ACCEPTED',
          status: ElectronicDocumentStatus.ACCEPTED,
        }),
      );
      expect(html).toContain('MOCK');
      expect(html).toContain('ACCEPTED');
    });

    it('nunca muestra providerExternalId (el tipo SafeElectronicDocument ni siquiera lo expone)', () => {
      const html = renderer.render(makeDoc());
      expect(html).not.toContain('providerExternalId');
    });

    it('muestra providerMessage cuando está presente y no vacío', () => {
      const html = renderer.render(
        makeDoc({ providerMessage: 'Mensaje saneado de prueba' }),
      );
      expect(html).toContain('Mensaje saneado de prueba');
    });

    it('sin providerMessage: no revienta, sin mostrar la línea', () => {
      const html = renderer.render(makeDoc({ providerMessage: null }));
      expect(html).not.toContain('Mensaje del proveedor');
    });
  });

  describe('aviso de demostración (MOCK, §10)', () => {
    it('siempre visible: "DOCUMENTO DE DEMOSTRACIÓN"', () => {
      const html = renderer.render(makeDoc());
      expect(html).toContain('DOCUMENTO DE DEMOSTRACIÓN');
    });

    it('para MOCK: menciona el proveedor y aclara que no implica aceptación SUNAT', () => {
      const html = renderer.render(makeDoc({ providerCode: 'MOCK' }));
      expect(html).toContain('Proveedor electrónico: MOCK');
      expect(html).toContain(
        'no implica aceptación, registro ni validez tributaria ante SUNAT',
      );
    });

    it('nunca usa redacción de aceptación SUNAT real', () => {
      const html = renderer.render(makeDoc());
      expect(html).not.toContain('Aceptado por SUNAT');
      expect(html).not.toContain('Registrado en SUNAT');
      expect(html).not.toContain('Comprobante SUNAT válido');
    });

    it('ACCEPTED bajo MOCK se contextualiza como aceptado por el proveedor de demostración, no SUNAT', () => {
      const html = renderer.render(
        makeDoc({
          status: ElectronicDocumentStatus.ACCEPTED,
          providerCode: 'MOCK',
        }),
      );
      expect(html).toContain('ACEPTADO POR PROVEEDOR DE DEMOSTRACIÓN');
    });
  });

  describe('resultado desconocido (§20)', () => {
    it('SUBMITTED + UNKNOWN_OUTCOME: advertencia visible, sin insinuar aceptado/rechazado', () => {
      const html = renderer.render(
        makeDoc({
          status: ElectronicDocumentStatus.SUBMITTED,
          providerStatus: 'UNKNOWN_OUTCOME',
        }),
      );
      expect(html).toContain('Resultado remoto no confirmado');
      expect(html).toContain('no debe reenviarse automáticamente');
      expect(html).not.toContain('ACEPTADO POR PROVEEDOR DE DEMOSTRACIÓN');
      expect(html).not.toContain('Rechazado por proveedor');
    });

    it('SUBMITTED sin UNKNOWN_OUTCOME: sin advertencia de resultado desconocido', () => {
      const html = renderer.render(
        makeDoc({
          status: ElectronicDocumentStatus.SUBMITTED,
          providerStatus: 'ACCEPTED',
        }),
      );
      expect(html).not.toContain('Resultado remoto no confirmado');
    });

    it('ACCEPTED no muestra la advertencia de resultado desconocido', () => {
      const html = renderer.render(
        makeDoc({ status: ElectronicDocumentStatus.ACCEPTED }),
      );
      expect(html).not.toContain('Resultado remoto no confirmado');
    });
  });

  describe('otros estados (§19)', () => {
    it('CREATED -> "Creado"', () => {
      const html = renderer.render(
        makeDoc({ status: ElectronicDocumentStatus.CREATED }),
      );
      expect(html).toContain('Creado');
    });

    it('SUBMISSION_FAILED -> "Fallo técnico de envío"', () => {
      const html = renderer.render(
        makeDoc({ status: ElectronicDocumentStatus.SUBMISSION_FAILED }),
      );
      expect(html).toContain('Fallo técnico de envío');
    });

    it('REJECTED -> "Rechazado por proveedor"', () => {
      const html = renderer.render(
        makeDoc({ status: ElectronicDocumentStatus.REJECTED }),
      );
      expect(html).toContain('Rechazado por proveedor');
    });
  });

  // ====================================================================
  // Escapado HTML / XSS (§32, obligatorio)
  // ====================================================================
  describe('escapado HTML (XSS)', () => {
    const XSS_PAYLOAD = '<script>alert(1)</script>';

    it('escapa <script> en el nombre del cliente', () => {
      const html = renderer.render(makeDoc({ customerName: XSS_PAYLOAD }));
      expect(html).not.toContain(XSS_PAYLOAD);
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('escapa <script> en la razón social del emisor', () => {
      const html = renderer.render(
        makeDoc({ issuerBusinessName: XSS_PAYLOAD }),
      );
      expect(html).not.toContain(XSS_PAYLOAD);
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('escapa <script> en la descripción de un ítem', () => {
      const html = renderer.render(
        makeDoc({
          items: [
            {
              lineNumber: 1,
              productSku: 'SKU-X',
              description: 'Producto <Especial>',
              unitCode: 'UND',
              unitName: 'Unidad',
              unitAbbreviation: 'und',
              quantity: '1.000',
              unitPrice: '1.00',
              lineTotal: '1.00',
            },
          ],
        }),
      );
      expect(html).not.toContain('Producto <Especial>');
      expect(html).toContain('Producto &lt;Especial&gt;');
    });

    it('escapa <script> en el SKU de un ítem', () => {
      const html = renderer.render(
        makeDoc({
          items: [
            {
              lineNumber: 1,
              productSku: '<script>x</script>',
              description: 'Producto',
              unitCode: 'UND',
              unitName: 'Unidad',
              unitAbbreviation: 'und',
              quantity: '1.000',
              unitPrice: '1.00',
              lineTotal: '1.00',
            },
          ],
        }),
      );
      expect(html).not.toContain('<script>x</script>');
      expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    });

    it('escapa direcciones (emisor y cliente)', () => {
      const html = renderer.render(
        makeDoc({
          issuerAddress: XSS_PAYLOAD,
          customerAddress: XSS_PAYLOAD,
        }),
      );
      expect(html).not.toContain(XSS_PAYLOAD);
      const occurrences =
        html.split('&lt;script&gt;alert(1)&lt;/script&gt;').length - 1;
      expect(occurrences).toBeGreaterThanOrEqual(2);
    });

    it('escapa providerMessage', () => {
      const html = renderer.render(makeDoc({ providerMessage: XSS_PAYLOAD }));
      expect(html).not.toContain(XSS_PAYLOAD);
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('escapa & correctamente (Empresa & Hijos "SAC") sin doble-escapar entidades', () => {
      const html = renderer.render(
        makeDoc({ customerName: 'Empresa & Hijos "SAC"' }),
      );
      expect(html).toContain('Empresa &amp; Hijos &quot;SAC&quot;');
      expect(html).not.toContain('Empresa & Hijos "SAC"');
      // Sin doble-escapado: nunca "&amp;amp;".
      expect(html).not.toContain('&amp;amp;');
    });

    it('escapa comillas simples', () => {
      const html = renderer.render(
        makeDoc({ customerName: "Cliente O'Brien" }),
      );
      expect(html).toContain('Cliente O&#39;Brien');
    });
  });
});

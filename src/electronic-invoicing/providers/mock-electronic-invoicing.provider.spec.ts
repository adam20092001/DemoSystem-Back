import { FiscalDocumentType } from '@prisma/client';
import { ElectronicDocumentSubmissionPayload } from './electronic-invoicing-provider.interface';
import { MockElectronicInvoicingProvider } from './mock-electronic-invoicing.provider';

function makePayload(
  overrides: Partial<ElectronicDocumentSubmissionPayload> = {},
): ElectronicDocumentSubmissionPayload {
  return {
    documentId: 'doc-1',
    documentType: FiscalDocumentType.FACTURA,
    series: 'F001',
    number: 1,
    currencyCode: 'PEN',
    issuerTaxId: '20100000001',
    issuerBusinessName: 'Empresa Demo SAC',
    issuerAddress: 'Av. Principal 100',
    customerDocumentType: null,
    customerDocumentNumber: null,
    customerName: 'Cliente Demo',
    customerAddress: null,
    subtotal: '100.00',
    discountAmount: '0.00',
    taxableBase: '100.00',
    taxAmount: '18.00',
    total: '118.00',
    items: [],
    ...overrides,
  };
}

describe('MockElectronicInvoicingProvider', () => {
  let provider: MockElectronicInvoicingProvider;

  beforeEach(() => {
    provider = new MockElectronicInvoicingProvider();
  });

  it('expone code = "MOCK"', () => {
    expect(provider.code).toBe('MOCK');
  });

  it('siempre devuelve un resultado ACCEPTED determinístico', async () => {
    const result = await provider.submit(makePayload());

    expect(result.outcome).toBe('ACCEPTED');
    expect(result.providerStatus).toBe('ACCEPTED');
    expect(typeof result.providerMessage).toBe('string');
    expect(result.providerMessage.length).toBeGreaterThan(0);
  });

  it('el externalId es estable/determinístico, derivado del documentId', async () => {
    const result1 = await provider.submit(
      makePayload({ documentId: 'doc-xyz' }),
    );
    const result2 = await provider.submit(
      makePayload({ documentId: 'doc-xyz' }),
    );

    expect(result1.externalId).toBe(result2.externalId);
    expect(result1.externalId).toContain('doc-xyz');
  });

  it('documentId distinto produce externalId distinto', async () => {
    const result1 = await provider.submit(makePayload({ documentId: 'doc-a' }));
    const result2 = await provider.submit(makePayload({ documentId: 'doc-b' }));

    expect(result1.externalId).not.toBe(result2.externalId);
  });

  it('el resultado es independiente de documentType/moneda/montos (sin ramas mágicas por RUC/monto)', async () => {
    const factura = await provider.submit(
      makePayload({
        documentType: FiscalDocumentType.FACTURA,
        total: '999999.99',
      }),
    );
    const boleta = await provider.submit(
      makePayload({ documentType: FiscalDocumentType.BOLETA, total: '0.01' }),
    );

    expect(factura.outcome).toBe('ACCEPTED');
    expect(boleta.outcome).toBe('ACCEPTED');
  });
});

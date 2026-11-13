import { normalizeNumber } from './document-key';
import { normalizeRceDocument, normalizeRvieDocument } from './normalizer';
import { dec, rceRaw, rvieRaw } from './test-helpers';

describe('normalizeRvieDocument', () => {
  it('normaliza una factura completa sin alertas', () => {
    const doc = normalizeRvieDocument(rvieRaw());
    expect(doc).toMatchObject({
      register: 'RVIE',
      period: '202601',
      docTypeCode: '01',
      series: 'F001',
      number: '1',
      issueDate: '2026-01-05',
      accountingDate: null,
      currencyCode: 'PEN',
      internalStatus: 'ACCEPTED_MOCK',
      flags: [],
    });
    expect(doc.counterparty).toEqual({
      docTypeCode: '6',
      docNumber: '99999000001',
      name: 'DEMO CLIENTE 1 SAC',
    });
    expect(doc.taxableBase?.toFixed(2)).toBe('847.46');
    expect(doc.igv.toFixed(2)).toBe('152.54');
    expect(doc.total.toFixed(2)).toBe('1000.00');
  });

  it('deriva el periodo y la fecha en America/Lima (límite de mes)', () => {
    // 04:59:59Z = 23:59:59 del 31/01 en Lima; 05:00:00Z = 00:00 del 01/02.
    const jan = normalizeRvieDocument(
      rvieRaw({ issuedAt: new Date('2026-02-01T04:59:59.000Z') }),
    );
    const feb = normalizeRvieDocument(
      rvieRaw({ issuedAt: new Date('2026-02-01T05:00:00.000Z') }),
    );
    expect(jan.period).toBe('202601');
    expect(jan.issueDate).toBe('2026-01-31');
    expect(feb.period).toBe('202602');
    expect(feb.issueDate).toBe('2026-02-01');
  });

  it('boleta sin cliente: opcional solo por debajo de S/ 700.00', () => {
    const base = {
      documentType: 'BOLETA' as const,
      customerDocumentType: null,
      customerDocumentNumber: null,
      customerName: 'Público general',
    };
    const low = normalizeRvieDocument(
      rvieRaw({
        ...base,
        total: dec('699.99'),
        taxableBase: dec('593.21'),
        taxAmount: dec('106.78'),
      }),
    );
    const edge = normalizeRvieDocument(
      rvieRaw({
        ...base,
        total: dec('700.00'),
        taxableBase: dec('593.22'),
        taxAmount: dec('106.78'),
      }),
    );
    expect(low.docTypeCode).toBe('03');
    expect(low.flags).not.toContain('COUNTERPARTY_INCOMPLETE');
    expect(edge.flags).toContain('COUNTERPARTY_INCOMPLETE');
  });

  it('factura sin cliente identificado queda incompleta', () => {
    const doc = normalizeRvieDocument(
      rvieRaw({ customerDocumentType: null, customerDocumentNumber: null }),
    );
    expect(doc.flags).toContain('COUNTERPARTY_INCOMPLETE');
  });

  it('sin IGV y con total positivo: base sin clasificar', () => {
    const doc = normalizeRvieDocument(
      rvieRaw({
        taxableBase: dec('1000.00'),
        taxAmount: dec('0.00'),
        total: dec('1000.00'),
      }),
    );
    expect(doc.taxableBase).toBeNull();
    expect(doc.flags).toEqual(['TAX_TREATMENT_UNCLASSIFIED']);
    expect(doc.igv.toFixed(2)).toBe('0.00');
  });

  it('total cero sin IGV no es "sin clasificar"', () => {
    const doc = normalizeRvieDocument(
      rvieRaw({ taxableBase: dec('0'), taxAmount: dec('0'), total: dec('0') }),
    );
    expect(doc.taxableBase?.toFixed(2)).toBe('0.00');
    expect(doc.flags).not.toContain('TAX_TREATMENT_UNCLASSIFIED');
  });

  it('marca aritmética inconsistente (base + IGV distinto del total)', () => {
    const doc = normalizeRvieDocument(rvieRaw({ total: dec('1000.01') }));
    expect(doc.flags).toEqual(['ARITHMETIC_INCONSISTENT']);
  });

  it('otra moneda: alerta y sin conversión', () => {
    const doc = normalizeRvieDocument(rvieRaw({ currencyCode: 'usd' }));
    expect(doc.currencyCode).toBe('USD');
    expect(doc.flags).toContain('CURRENCY_UNSUPPORTED');
    expect(doc.total.toFixed(2)).toBe('1000.00');
  });

  it('OTHER no se mapea arbitrariamente', () => {
    const doc = normalizeRvieDocument(
      rvieRaw({ customerDocumentType: 'OTHER', customerDocumentNumber: 'X-1' }),
    );
    expect(doc.counterparty.docTypeCode).toBeNull();
    expect(doc.flags).toContain('COUNTERPARTY_DOC_TYPE_UNMAPPED');
  });

  it.each([
    ['DNI', '1', '12345678', false],
    ['DNI', '1', '1234567', true],
    ['RUC', '6', '9999900000', true],
    ['CE', '4', 'AB1', false],
    ['PASSPORT', '7', 'P-1', false],
  ] as const)(
    'tipo %s -> código %s (%s) formato inválido=%s',
    (type, code, number, invalid) => {
      const doc = normalizeRvieDocument(
        rvieRaw({ customerDocumentType: type, customerDocumentNumber: number }),
      );
      expect(doc.counterparty.docTypeCode).toBe(code);
      expect(doc.flags.includes('COUNTERPARTY_DOC_FORMAT_INVALID')).toBe(
        invalid,
      );
    },
  );
});

describe('normalizeRceDocument', () => {
  it('normaliza una factura de compra y usa accountingDate para el periodo', () => {
    const doc = normalizeRceDocument(
      rceRaw({
        issueDate: new Date('2025-12-28T00:00:00.000Z'),
        accountingDate: new Date('2026-01-12T00:00:00.000Z'),
      }),
    );
    expect(doc).toMatchObject({
      register: 'RCE',
      period: '202601',
      docTypeCode: '01',
      series: 'E001',
      number: '101',
      issueDate: '2025-12-28',
      accountingDate: '2026-01-12',
      internalStatus: 'CONFIRMED',
      flags: [],
    });
    expect(doc.counterparty).toEqual({
      docTypeCode: '6',
      docNumber: '99999100001',
      name: 'DEMO PROVEEDOR 1 SAC',
    });
  });

  it('RECIBO y OTHER no tienen código de comprobante', () => {
    for (const documentType of ['RECIBO', 'OTHER'] as const) {
      const doc = normalizeRceDocument(rceRaw({ documentType }));
      expect(doc.docTypeCode).toBeNull();
      expect(doc.flags).toContain('DOC_TYPE_UNMAPPED');
    }
  });

  it('FOREIGN_TAX_ID y OTHER del proveedor no se mapean', () => {
    for (const supplierDocumentType of ['FOREIGN_TAX_ID', 'OTHER'] as const) {
      const doc = normalizeRceDocument(rceRaw({ supplierDocumentType }));
      expect(doc.counterparty.docTypeCode).toBeNull();
      expect(doc.flags).toContain('COUNTERPARTY_DOC_TYPE_UNMAPPED');
    }
  });

  it('sin serie: serie vacía; número sin ceros a la izquierda', () => {
    const doc = normalizeRceDocument(
      rceRaw({ documentSeries: null, documentNumber: '000123' }),
    );
    expect(doc.series).toBe('');
    expect(doc.number).toBe('123');
  });

  it('el proveedor siempre se exige completo', () => {
    const doc = normalizeRceDocument(rceRaw({ supplierLegalName: '  ' }));
    expect(doc.flags).toContain('COUNTERPARTY_INCOMPLETE');
  });
});

describe('normalizeNumber', () => {
  it.each([
    ['00000012', '12'],
    ['000', '0'],
    [' ab-001 ', 'AB-001'],
    ['7', '7'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeNumber(input)).toBe(expected);
  });
});

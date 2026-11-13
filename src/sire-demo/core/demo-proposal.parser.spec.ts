import {
  DEMO_V1_COLUMNS_LINE,
  parseDemoProposal,
} from './demo-proposal.parser';

const HEADER = '#DEMO_V1|SOURCE=POS|REGISTER=RVIE|PERIOD=202601';
const ROW =
  '01|F001|00000012|05/01/2026|6|99999000001|DEMO CLIENTE 1 SAC|PEN|847.46|152.54|1000.00';

function file(...rows: string[]): string {
  return `${[HEADER, DEMO_V1_COLUMNS_LINE, ...rows].join('\n')}\n`;
}

function errorCodes(input: Buffer | string, options = {}): string[] {
  const result = parseDemoProposal(input, options);
  if (result.ok) {
    throw new Error('Se esperaba un error de parseo');
  }
  return result.errors.map((e) => e.code);
}

describe('parseDemoProposal', () => {
  it('parsea un archivo válido y normaliza serie, número y montos', () => {
    const result = parseDemoProposal(file(ROW));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.header).toEqual({
      formatVersion: 'DEMO_V1',
      source: 'POS',
      register: 'RVIE',
      period: '202601',
      fixtureSetVersion: null,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      lineNumber: 1,
      docTypeCode: '01',
      series: 'F001',
      number: '12',
      issueDate: '2026-01-05',
      cpDocTypeCode: '6',
      cpDocNumber: '99999000001',
      currencyCode: 'PEN',
    });
    expect(result.rows[0].total.toFixed(2)).toBe('1000.00');
  });

  it('acepta BOM, CRLF y líneas finales en blanco', () => {
    const bom = String.fromCharCode(0xfeff);
    const crlf = file(ROW).replace(/\n/g, '\r\n');
    const text = `${bom}${crlf}\r\n\r\n`;
    expect(parseDemoProposal(Buffer.from(text, 'utf8')).ok).toBe(true);
  });

  it('acepta cliente vacío (boleta menor) pero exige el par tipo+número', () => {
    const anonymous =
      '03|B001|00000001|05/01/2026|||PUBLICO|PEN|84.75|15.25|100.00';
    expect(parseDemoProposal(file(anonymous)).ok).toBe(true);
    const half = '03|B001|00000001|05/01/2026|1||X|PEN|84.75|15.25|100.00';
    expect(errorCodes(file(half))).toContain('COUNTERPARTY_PAIR');
  });

  it('RCE exige el documento del proveedor', () => {
    const rce = `#DEMO_V1|SOURCE=POS|REGISTER=RCE|PERIOD=202601\n${DEMO_V1_COLUMNS_LINE}\n03|B001|00000001|05/01/2026|||X|PEN|84.75|15.25|100.00\n`;
    expect(errorCodes(rce)).toContain('SUPPLIER_DOCUMENT_REQUIRED');
  });

  describe('cabecera', () => {
    it.each([
      ['sin #DEMO_V1', '#OFICIAL|SOURCE=POS|REGISTER=RVIE|PERIOD=202601'],
      ['SOURCE inválido', '#DEMO_V1|SOURCE=X|REGISTER=RVIE|PERIOD=202601'],
      ['REGISTER inválido', '#DEMO_V1|SOURCE=POS|REGISTER=Z|PERIOD=202601'],
      ['PERIOD mes 13', '#DEMO_V1|SOURCE=POS|REGISTER=RVIE|PERIOD=202613'],
      [
        'FIXTURES sin FIXTURE',
        '#DEMO_V1|SOURCE=DEMO_FIXTURES|REGISTER=RVIE|PERIOD=202601',
      ],
      [
        'POS con FIXTURE',
        '#DEMO_V1|SOURCE=POS|REGISTER=RVIE|PERIOD=202601|FIXTURE=demo-fixtures-v1',
      ],
      [
        'clave desconocida',
        '#DEMO_V1|SOURCE=POS|REGISTER=RVIE|PERIOD=202601|X=1',
      ],
      [
        'clave repetida',
        '#DEMO_V1|SOURCE=POS|SOURCE=POS|REGISTER=RVIE|PERIOD=202601',
      ],
    ])('rechaza: %s', (_label, header) => {
      const text = `${header}\n${DEMO_V1_COLUMNS_LINE}\n${ROW}\n`;
      expect(errorCodes(text)).toContain('INVALID_HEADER');
    });

    it('acepta SOURCE=DEMO_FIXTURES con FIXTURE', () => {
      const text = `#DEMO_V1|SOURCE=DEMO_FIXTURES|REGISTER=RVIE|PERIOD=202601|FIXTURE=demo-fixtures-v1\n${DEMO_V1_COLUMNS_LINE}\n${ROW}\n`;
      const result = parseDemoProposal(text);
      expect(result.ok && result.header.fixtureSetVersion).toBe(
        'demo-fixtures-v1',
      );
    });

    it('valida que coincida con lo esperado (formulario de carga)', () => {
      expect(errorCodes(file(ROW), { expected: { period: '202602' } })).toEqual(
        ['HEADER_MISMATCH'],
      );
      expect(
        errorCodes(file(ROW), { expected: { source: 'DEMO_FIXTURES' } }),
      ).toEqual(['HEADER_MISMATCH']);
      expect(
        parseDemoProposal(file(ROW), {
          expected: { register: 'RVIE', source: 'POS', period: '202601' },
        }).ok,
      ).toBe(true);
    });

    it('rechaza columnas distintas', () => {
      const text = `${HEADER}\n#COLUMNS|a|b\n${ROW}\n`;
      expect(errorCodes(text)).toEqual(['INVALID_COLUMNS']);
    });
  });

  describe('filas', () => {
    it.each([
      [
        'tipo de comprobante 07',
        '07|F001|1|05/01/2026|6|99999000001|X|PEN|1.00|0.00|1.00',
        'INVALID_DOC_TYPE',
      ],
      [
        'serie con símbolo',
        '01|F-01|1|05/01/2026|6|99999000001|X|PEN|1.00|0.00|1.00',
        'INVALID_SERIES',
      ],
      [
        'número no numérico',
        '01|F001|A1|05/01/2026|6|99999000001|X|PEN|1.00|0.00|1.00',
        'INVALID_NUMBER',
      ],
      [
        'fecha inexistente',
        '01|F001|1|31/02/2026|6|99999000001|X|PEN|1.00|0.00|1.00',
        'INVALID_DATE',
      ],
      [
        'fecha ISO',
        '01|F001|1|2026-01-05|6|99999000001|X|PEN|1.00|0.00|1.00',
        'INVALID_DATE',
      ],
      [
        'tipo de documento 9',
        '01|F001|1|05/01/2026|9|99999000001|X|PEN|1.00|0.00|1.00',
        'INVALID_COUNTERPARTY_DOC_TYPE',
      ],
      [
        'moneda USD',
        '01|F001|1|05/01/2026|6|99999000001|X|USD|1.00|0.00|1.00',
        'INVALID_CURRENCY',
      ],
      [
        'monto con coma',
        '01|F001|1|05/01/2026|6|99999000001|X|PEN|1,000.00|0.00|1.00',
        'INVALID_AMOUNT',
      ],
      [
        'monto negativo',
        '01|F001|1|05/01/2026|6|99999000001|X|PEN|-1.00|0.00|1.00',
        'INVALID_AMOUNT',
      ],
      [
        '3 decimales',
        '01|F001|1|05/01/2026|6|99999000001|X|PEN|1.001|0.00|1.00',
        'INVALID_AMOUNT',
      ],
      [
        'nombre muy largo',
        `01|F001|1|05/01/2026|6|99999000001|${'N'.repeat(151)}|PEN|1.00|0.00|1.00`,
        'INVALID_COUNTERPARTY_NAME',
      ],
      ['campos de menos', '01|F001|1|05/01/2026', 'ROW_FIELD_COUNT'],
      ['campos de más', `${ROW}|extra`, 'ROW_FIELD_COUNT'],
    ])('rechaza: %s', (_label, row, code) => {
      expect(errorCodes(file(row))).toContain(code);
    });

    it('rechaza líneas en blanco intermedias y líneas demasiado largas', () => {
      expect(errorCodes(file(ROW, '', ROW))).toContain('BLANK_LINE');
      expect(errorCodes(file(`${ROW}${'x'.repeat(1001)}`))).toContain(
        'LINE_TOO_LONG',
      );
    });

    it('es todo o nada: una fila inválida invalida el archivo completo', () => {
      const result = parseDemoProposal(
        file(
          ROW,
          '01|F001|1|31/02/2026|6|99999000001|X|PEN|1.00|0.00|1.00',
          ROW,
        ),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors[0]).toMatchObject({ line: 4, field: 'issueDate' });
    });

    it('limita los errores reportados pero informa el total', () => {
      const bad = '01|F-01|1|05/01/2026|6|99999000001|X|PEN|1.00|0.00|1.00';
      const result = parseDemoProposal(
        file(...Array.from({ length: 80 }, () => bad)),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toHaveLength(50);
      expect(result.totalErrors).toBe(80);
    });
  });

  describe('límites del archivo', () => {
    it('acepta exactamente 5000 filas y rechaza 5001', () => {
      const rows = Array.from({ length: 5000 }, () => ROW);
      const ok = parseDemoProposal(file(...rows));
      expect(ok.ok && ok.rows.length).toBe(5000);
      expect(errorCodes(file(...rows, ROW))).toEqual(['MAX_ROWS_EXCEEDED']);
    });

    it('rechaza más de 2 MB sin analizar el contenido', () => {
      expect(errorCodes(Buffer.alloc(2 * 1024 * 1024 + 1, 'a'))).toEqual([
        'FILE_TOO_LARGE',
      ]);
    });

    it('rechaza contenido no UTF-8, binario y vacío', () => {
      expect(errorCodes(Buffer.from([0xff, 0xfe, 0x41]))).toEqual(['NOT_UTF8']);
      expect(errorCodes(`${HEADER}\u0000\n`)).toEqual(['BINARY_CONTENT']);
      expect(errorCodes('')).toEqual(['EMPTY_FILE']);
      expect(errorCodes(`${HEADER}\n${DEMO_V1_COLUMNS_LINE}\n`)).toEqual([
        'NO_ROWS',
      ]);
    });
  });
});

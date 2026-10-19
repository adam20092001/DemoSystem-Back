import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { ExcelColumn } from './excel-column';
import { ExcelExportService } from './excel-export.service';
import { MAX_EXPORT_ROWS } from './excel-export.constants';

interface Row {
  code: string;
  description: string;
  amount: number;
  issuedAt: Date;
  active: boolean | null;
}

const COLUMNS: ExcelColumn<Row>[] = [
  { key: 'code', header: 'Código', type: 'identifier', value: (r) => r.code },
  {
    key: 'description',
    header: 'Descripción',
    type: 'string',
    value: (r) => r.description,
  },
  { key: 'amount', header: 'Monto', type: 'number', value: (r) => r.amount },
  {
    key: 'issuedAt',
    header: 'Fecha',
    type: 'date',
    value: (r) => r.issuedAt,
  },
  { key: 'active', header: 'Activo', type: 'boolean', value: (r) => r.active },
];

async function readBackWorkbook(buffer: Buffer): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- desajuste conocido entre Buffer<ArrayBufferLike> (@types/node reciente) y el Buffer no genérico de los tipos de exceljs; verificado en runtime, solo de tipos.
  await workbook.xlsx.load(buffer as any);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error('El workbook de prueba no tiene ninguna hoja');
  }
  return sheet;
}

describe('ExcelExportService', () => {
  let service: ExcelExportService;

  beforeEach(() => {
    service = new ExcelExportService();
  });

  describe('assertWithinExportLimit', () => {
    it('total dentro del máximo: no lanza', () => {
      expect(() =>
        service.assertWithinExportLimit(MAX_EXPORT_ROWS, 'ventas'),
      ).not.toThrow();
    });

    it('total exactamente en el máximo: no lanza (límite inclusivo)', () => {
      expect(() =>
        service.assertWithinExportLimit(MAX_EXPORT_ROWS, 'ventas'),
      ).not.toThrow();
    });

    it('total por encima del máximo: BadRequestException, con el máximo y el total en el mensaje', () => {
      expect(() =>
        service.assertWithinExportLimit(MAX_EXPORT_ROWS + 1, 'ventas'),
      ).toThrow(BadRequestException);
      try {
        service.assertWithinExportLimit(25000, 'ventas');
        fail('debía lanzar');
      } catch (error) {
        expect((error as BadRequestException).message).toContain('25000');
        expect((error as BadRequestException).message).toContain(
          String(MAX_EXPORT_ROWS),
        );
      }
    });
  });

  describe('buildWorkbook', () => {
    it('genera un workbook .xlsx real, parseable por ExcelJS', async () => {
      const buffer = await service.buildWorkbook<Row>('Hoja', COLUMNS, [
        {
          code: '007',
          description: 'Producto normal',
          amount: 19.9,
          issuedAt: new Date('2026-03-15T00:00:00.000Z'),
          active: true,
        },
      ]);
      expect(Buffer.isBuffer(buffer)).toBe(true);
      const sheet = await readBackWorkbook(buffer);
      expect(sheet.rowCount).toBe(2); // encabezado + 1 fila
    });

    it('encabezados exactos, en el mismo orden que las columnas', async () => {
      const buffer = await service.buildWorkbook<Row>('Hoja', COLUMNS, []);
      const sheet = await readBackWorkbook(buffer);
      const headerRow = sheet.getRow(1);
      expect(
        COLUMNS.map((_, index) => headerRow.getCell(index + 1).value),
      ).toEqual(['Código', 'Descripción', 'Monto', 'Fecha', 'Activo']);
    });

    it('encabezado en negrita', async () => {
      const buffer = await service.buildWorkbook<Row>('Hoja', COLUMNS, []);
      const sheet = await readBackWorkbook(buffer);
      expect(sheet.getRow(1).getCell(1).font?.bold).toBe(true);
    });

    it('celda numérica: se escribe como number, nunca como texto', async () => {
      const buffer = await service.buildWorkbook<Row>('Hoja', COLUMNS, [
        {
          code: '1',
          description: 'x',
          amount: -150.5,
          issuedAt: new Date('2026-01-01'),
          active: null,
        },
      ]);
      const sheet = await readBackWorkbook(buffer);
      const cell = sheet.getRow(2).getCell(3);
      expect(typeof cell.value).toBe('number');
      expect(cell.value).toBe(-150.5);
    });

    it('celda de fecha: se escribe como Date, no como string', async () => {
      const issuedAt = new Date('2026-03-15T00:00:00.000Z');
      const buffer = await service.buildWorkbook<Row>('Hoja', COLUMNS, [
        {
          code: '1',
          description: 'x',
          amount: 1,
          issuedAt,
          active: true,
        },
      ]);
      const sheet = await readBackWorkbook(buffer);
      const cell = sheet.getRow(2).getCell(4);
      expect(cell.value).toBeInstanceOf(Date);
      expect((cell.value as Date).toISOString()).toBe(issuedAt.toISOString());
    });

    it('identificador con ceros a la izquierda: se conserva tal cual, como texto', async () => {
      const buffer = await service.buildWorkbook<Row>('Hoja', COLUMNS, [
        {
          code: '00042',
          description: 'x',
          amount: 1,
          issuedAt: new Date('2026-01-01'),
          active: true,
        },
      ]);
      const sheet = await readBackWorkbook(buffer);
      const cell = sheet.getRow(2).getCell(1);
      expect(cell.value).toBe('00042');
      expect(typeof cell.value).toBe('string');
    });

    it('valor null: celda vacía, sin lanzar', async () => {
      const buffer = await service.buildWorkbook<Row>('Hoja', COLUMNS, [
        {
          code: '1',
          description: 'x',
          amount: 1,
          issuedAt: new Date('2026-01-01'),
          active: null,
        },
      ]);
      const sheet = await readBackWorkbook(buffer);
      const cell = sheet.getRow(2).getCell(5);
      expect(cell.value).toBeNull();
    });

    it('conjunto vacío de filas: workbook válido con solo el encabezado', async () => {
      const buffer = await service.buildWorkbook<Row>('Hoja', COLUMNS, []);
      const sheet = await readBackWorkbook(buffer);
      expect(sheet.rowCount).toBe(1);
    });

    it('texto peligroso (inyección de fórmula): se neutraliza con comilla simple en la celda final', async () => {
      const buffer = await service.buildWorkbook<Row>('Hoja', COLUMNS, [
        {
          code: '1',
          description: '=cmd|/C calc!A1',
          amount: 1,
          issuedAt: new Date('2026-01-01'),
          active: true,
        },
      ]);
      const sheet = await readBackWorkbook(buffer);
      const cell = sheet.getRow(2).getCell(2);
      expect(cell.value as string).toBe("'=cmd|/C calc!A1");
    });

    it('identificador con prefijo peligroso también se neutraliza (mismo criterio que string)', async () => {
      const buffer = await service.buildWorkbook<Row>('Hoja', COLUMNS, [
        {
          code: '=HYPERLINK("http://evil")',
          description: 'x',
          amount: 1,
          issuedAt: new Date('2026-01-01'),
          active: true,
        },
      ]);
      const sheet = await readBackWorkbook(buffer);
      const cell = sheet.getRow(2).getCell(1);
      expect(cell.value as string).toBe('\'=HYPERLINK("http://evil")');
    });

    it('monto negativo legítimo nunca se sanitiza como texto (solo columnas string/identifier pasan por el sanitizador)', async () => {
      const buffer = await service.buildWorkbook<Row>('Hoja', COLUMNS, [
        {
          code: '1',
          description: 'x',
          amount: -99.99,
          issuedAt: new Date('2026-01-01'),
          active: true,
        },
      ]);
      const sheet = await readBackWorkbook(buffer);
      const cell = sheet.getRow(2).getCell(3);
      expect(cell.value).toBe(-99.99);
      expect(typeof cell.value).toBe('number');
    });

    it('autoFilter aplicado sobre la fila de encabezado, abarcando todas las columnas', async () => {
      const buffer = await service.buildWorkbook<Row>('Hoja', COLUMNS, []);
      const sheet = await readBackWorkbook(buffer);
      expect(sheet.autoFilter).toBeDefined();
    });

    it('respeta el orden de filas recibido (determinista, sin reordenar)', async () => {
      const rows: Row[] = [
        {
          code: 'B',
          description: 'segunda',
          amount: 2,
          issuedAt: new Date('2026-01-02'),
          active: true,
        },
        {
          code: 'A',
          description: 'primera',
          amount: 1,
          issuedAt: new Date('2026-01-01'),
          active: true,
        },
      ];
      const buffer = await service.buildWorkbook<Row>('Hoja', COLUMNS, rows);
      const sheet = await readBackWorkbook(buffer);
      expect(sheet.getRow(2).getCell(1).value).toBe('B');
      expect(sheet.getRow(3).getCell(1).value).toBe('A');
    });
  });
});

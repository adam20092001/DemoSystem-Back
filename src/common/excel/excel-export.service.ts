import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { ExcelColumn } from './excel-column';
import { MAX_EXPORT_ROWS } from './excel-export.constants';
import { sanitizeExcelString } from './sanitize-excel-string';

const HEADER_FILL_ARGB = 'FFE5E7EB';
const DEFAULT_COLUMN_WIDTH = 18;

/**
 * NR-06: utilidad genérica y reutilizable para construir un workbook .xlsx
 * real (no un CSV renombrado) a partir de columnas tipadas y filas ya
 * calculadas por el servicio de dominio correspondiente. NUNCA recalcula
 * ningún monto/impuesto/descuento: solo formatea valores que el llamador
 * ya resolvió (reutilizando sus mappers seguros existentes).
 *
 * Sin acceso a Prisma ni a ninguna policy de autorización: el alcance por
 * vendedor y los filtros se resuelven ANTES, en cada servicio de dominio
 * (reutilizando su propio `list()`), nunca aquí.
 */
@Injectable()
export class ExcelExportService {
  /**
   * Debe llamarse con el `total` YA calculado (mismo `where` que la
   * consulta de listado normal) ANTES de leer ninguna fila adicional ni
   * construir ningún workbook: un resultado que excede el máximo responde
   * 400 de inmediato, sin truncar en silencio ni devolver un archivo
   * parcial.
   */
  assertWithinExportLimit(totalCount: number, resourceLabel: string): void {
    if (totalCount > MAX_EXPORT_ROWS) {
      throw new BadRequestException(
        `La exportación de ${resourceLabel} tiene ${totalCount} resultados, por encima del máximo permitido de ${MAX_EXPORT_ROWS}. Acota los filtros (por ejemplo, el rango de fechas) antes de exportar.`,
      );
    }
  }

  async buildWorkbook<T>(
    sheetName: string,
    columns: ExcelColumn<T>[],
    rows: readonly T[],
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'DemoSystem POS';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(sheetName, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    sheet.columns = columns.map((column) => ({
      key: column.key,
      header: column.header,
      width: column.width ?? DEFAULT_COLUMN_WIDTH,
      style: this.styleForColumnType(column.type),
    }));

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: HEADER_FILL_ARGB },
    };
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length },
    };

    for (const row of rows) {
      const rowData: Record<string, string | number | Date | boolean | null> =
        {};
      for (const column of columns) {
        rowData[column.key] = this.cellValue(column, row);
      }
      sheet.addRow(rowData);
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  private styleForColumnType(
    type: ExcelColumn<unknown>['type'],
  ): Partial<ExcelJS.Style> | undefined {
    switch (type) {
      case 'number':
        return { numFmt: '#,##0.00' };
      case 'date':
        return { numFmt: 'yyyy-mm-dd' };
      // 'identifier': formato de celda "Texto" — un SKU/documento con
      // ceros a la izquierda nunca debe reinterpretarse como number.
      case 'identifier':
        return { numFmt: '@' };
      default:
        return undefined;
    }
  }

  private cellValue<T>(
    column: ExcelColumn<T>,
    row: T,
  ): string | number | Date | boolean | null {
    const rawValue = column.value(row);
    if (rawValue === null) {
      return null;
    }
    if (column.type === 'string' || column.type === 'identifier') {
      return sanitizeExcelString(String(rawValue));
    }
    return rawValue;
  }
}

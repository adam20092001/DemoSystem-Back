import { Prisma } from '@prisma/client';
import { isValidDateOnly } from '../../common/date/business-date';
import {
  SIRE_DEMO_CURRENCY,
  SIRE_DEMO_FORMAT_VERSION,
  SIRE_DEMO_MAX_FILE_BYTES,
  SIRE_DEMO_MAX_LINE_LENGTH,
  SIRE_DEMO_MAX_PARSE_ERRORS,
  SIRE_DEMO_MAX_ROWS,
} from '../sire-demo.constants';
import {
  normalizeDocNumber,
  normalizeNumber,
  normalizeSeries,
} from './document-key';
import { isValidPeriod } from './period';
import {
  ProposalRow,
  SIRE_REGISTERS,
  SIRE_SOURCES,
  SireRegister,
  SireSource,
} from './types';

/**
 * Formato propio DEMO_V1 (NO es un layout oficial de SUNAT).
 *
 *   #DEMO_V1|SOURCE=<POS|DEMO_FIXTURES>|REGISTER=<RVIE|RCE>|PERIOD=<YYYYMM>[|FIXTURE=<versión>]
 *   #COLUMNS|docTypeCode|series|number|issueDate|cpDocTypeCode|cpDocNumber|cpName|currency|taxableBase|igv|total
 *   <fila>|<fila>|... (11 campos separados por "|")
 *
 * Solo .txt UTF-8. Sin CAR, sin tickets, sin columnas oficiales.
 */
export const DEMO_V1_COLUMNS = [
  'docTypeCode',
  'series',
  'number',
  'issueDate',
  'cpDocTypeCode',
  'cpDocNumber',
  'cpName',
  'currency',
  'taxableBase',
  'igv',
  'total',
] as const;

export const DEMO_V1_COLUMNS_LINE = `#COLUMNS|${DEMO_V1_COLUMNS.join('|')}`;

export interface DemoProposalHeader {
  formatVersion: typeof SIRE_DEMO_FORMAT_VERSION;
  source: SireSource;
  register: SireRegister;
  period: string;
  fixtureSetVersion: string | null;
}

export interface DemoProposalParseError {
  /** Número de línea del archivo (1 = cabecera). 0 = error global del archivo. */
  line: number;
  field: string;
  code: string;
  message: string;
}

export type DemoProposalParseResult =
  | { ok: true; header: DemoProposalHeader; rows: ProposalRow[] }
  | {
      ok: false;
      errors: DemoProposalParseError[];
      /** Total real de errores detectados (puede superar `errors.length`). */
      totalErrors: number;
    };

export interface DemoProposalParseOptions {
  /** Si se indica, la cabecera debe coincidir exactamente (S2: formulario de carga). */
  expected?: Partial<
    Pick<DemoProposalHeader, 'source' | 'register' | 'period'>
  >;
}

const FIXTURE_VERSION_PATTERN = /^[a-z0-9][a-z0-9.-]{0,39}$/;
const AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const CP_DOC_TYPES: readonly string[] = ['1', '4', '6', '7'];
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

class ErrorCollector {
  readonly errors: DemoProposalParseError[] = [];
  total = 0;

  add(line: number, field: string, code: string, message: string): void {
    this.total += 1;
    if (this.errors.length < SIRE_DEMO_MAX_PARSE_ERRORS) {
      this.errors.push({ line, field, code, message });
    }
  }
}

function parseHeader(
  line: string,
  errors: ErrorCollector,
  expected: DemoProposalParseOptions['expected'],
): DemoProposalHeader | null {
  const parts = line.split('|');
  if (parts[0] !== `#${SIRE_DEMO_FORMAT_VERSION}`) {
    errors.add(
      1,
      'header',
      'INVALID_HEADER',
      `La primera línea debe iniciar con #${SIRE_DEMO_FORMAT_VERSION} (este formato propio no es un layout oficial de SUNAT).`,
    );
    return null;
  }

  const values = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    if (
      eq === -1 ||
      !['SOURCE', 'REGISTER', 'PERIOD', 'FIXTURE'].includes(key) ||
      values.has(key)
    ) {
      errors.add(
        1,
        'header',
        'INVALID_HEADER',
        `Campo de cabecera inválido o repetido: "${part}".`,
      );
      return null;
    }
    values.set(key, part.slice(eq + 1));
  }

  const source = values.get('SOURCE');
  const register = values.get('REGISTER');
  const period = values.get('PERIOD');
  const fixture = values.get('FIXTURE');
  let valid = true;

  if (!SIRE_SOURCES.includes(source as SireSource)) {
    errors.add(
      1,
      'SOURCE',
      'INVALID_HEADER',
      'SOURCE debe ser POS o DEMO_FIXTURES.',
    );
    valid = false;
  }
  if (!SIRE_REGISTERS.includes(register as SireRegister)) {
    errors.add(
      1,
      'REGISTER',
      'INVALID_HEADER',
      'REGISTER debe ser RVIE o RCE.',
    );
    valid = false;
  }
  if (period === undefined || !isValidPeriod(period)) {
    errors.add(
      1,
      'PERIOD',
      'INVALID_HEADER',
      'PERIOD debe tener formato YYYYMM (mes 01-12).',
    );
    valid = false;
  }
  if (source === 'DEMO_FIXTURES') {
    if (fixture === undefined || !FIXTURE_VERSION_PATTERN.test(fixture)) {
      errors.add(
        1,
        'FIXTURE',
        'INVALID_HEADER',
        'SOURCE=DEMO_FIXTURES exige FIXTURE=<versión> válida.',
      );
      valid = false;
    }
  } else if (source === 'POS' && fixture !== undefined) {
    errors.add(1, 'FIXTURE', 'INVALID_HEADER', 'SOURCE=POS no admite FIXTURE.');
    valid = false;
  }
  if (!valid) {
    return null;
  }

  const header: DemoProposalHeader = {
    formatVersion: SIRE_DEMO_FORMAT_VERSION,
    source: source as SireSource,
    register: register as SireRegister,
    period: period as string,
    fixtureSetVersion: fixture ?? null,
  };

  if (expected) {
    for (const field of ['source', 'register', 'period'] as const) {
      const wanted = expected[field];
      if (wanted !== undefined && header[field] !== wanted) {
        errors.add(
          1,
          field.toUpperCase(),
          'HEADER_MISMATCH',
          `La cabecera declara ${field.toUpperCase()}=${header[field]} pero se esperaba ${wanted}.`,
        );
        return null;
      }
    }
  }
  return header;
}

function parseRow(
  fields: string[],
  lineNumber: number,
  fileLine: number,
  register: SireRegister,
  errors: ErrorCollector,
): ProposalRow | null {
  const before = errors.total;
  const [
    docTypeCode,
    seriesRaw,
    numberRaw,
    issueDateRaw,
    cpDocTypeRaw,
    cpDocNumberRaw,
    cpNameRaw,
    currency,
    baseRaw,
    igvRaw,
    totalRaw,
  ] = fields.map((f) => f.trim());

  if (docTypeCode !== '01' && docTypeCode !== '03') {
    errors.add(
      fileLine,
      'docTypeCode',
      'INVALID_DOC_TYPE',
      'docTypeCode debe ser 01 o 03 (códigos PROVISIONALES de la demo).',
    );
  }
  if (!/^[A-Za-z0-9]{1,20}$/.test(seriesRaw)) {
    errors.add(
      fileLine,
      'series',
      'INVALID_SERIES',
      'series debe ser alfanumérica de 1 a 20 caracteres.',
    );
  }
  if (!/^\d{1,20}$/.test(numberRaw)) {
    errors.add(
      fileLine,
      'number',
      'INVALID_NUMBER',
      'number debe ser numérico de 1 a 20 dígitos.',
    );
  }

  let issueDate = '';
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(issueDateRaw);
  if (dateMatch) {
    issueDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
  }
  if (issueDate === '' || !isValidDateOnly(issueDate)) {
    errors.add(
      fileLine,
      'issueDate',
      'INVALID_DATE',
      'issueDate debe ser una fecha real DD/MM/AAAA.',
    );
  }

  const hasCpType = cpDocTypeRaw !== '';
  const hasCpNumber = cpDocNumberRaw !== '';
  if (hasCpType && !CP_DOC_TYPES.includes(cpDocTypeRaw)) {
    errors.add(
      fileLine,
      'cpDocTypeCode',
      'INVALID_COUNTERPARTY_DOC_TYPE',
      'cpDocTypeCode debe ser 1, 4, 6 o 7 (provisional) o estar vacío.',
    );
  }
  if (hasCpNumber && !/^[A-Za-z0-9-]{1,20}$/.test(cpDocNumberRaw)) {
    errors.add(
      fileLine,
      'cpDocNumber',
      'INVALID_COUNTERPARTY_DOC_NUMBER',
      'cpDocNumber debe ser alfanumérico de hasta 20 caracteres o estar vacío.',
    );
  }
  if (hasCpType !== hasCpNumber) {
    errors.add(
      fileLine,
      'cpDocNumber',
      'COUNTERPARTY_PAIR',
      'cpDocTypeCode y cpDocNumber deben informarse juntos o ambos vacíos.',
    );
  }
  if (register === 'RCE' && !hasCpNumber) {
    errors.add(
      fileLine,
      'cpDocNumber',
      'SUPPLIER_DOCUMENT_REQUIRED',
      'En RCE el documento del proveedor es obligatorio.',
    );
  }
  if (cpNameRaw.length > 150 || CONTROL_CHARS.test(cpNameRaw)) {
    errors.add(
      fileLine,
      'cpName',
      'INVALID_COUNTERPARTY_NAME',
      'cpName admite hasta 150 caracteres sin caracteres de control.',
    );
  }
  if (currency !== SIRE_DEMO_CURRENCY) {
    errors.add(
      fileLine,
      'currency',
      'INVALID_CURRENCY',
      `Solo se admite ${SIRE_DEMO_CURRENCY}: la demo no convierte monedas.`,
    );
  }
  for (const [name, value] of [
    ['taxableBase', baseRaw],
    ['igv', igvRaw],
    ['total', totalRaw],
  ] as const) {
    if (!AMOUNT_PATTERN.test(value)) {
      errors.add(
        fileLine,
        name,
        'INVALID_AMOUNT',
        `${name} debe ser un decimal >= 0 con hasta 2 decimales.`,
      );
    }
  }

  if (errors.total > before) {
    return null;
  }

  return {
    lineNumber,
    docTypeCode,
    series: normalizeSeries(seriesRaw),
    number: normalizeNumber(numberRaw),
    issueDate,
    cpDocTypeCode: hasCpType ? cpDocTypeRaw : null,
    cpDocNumber: hasCpNumber ? normalizeDocNumber(cpDocNumberRaw) : null,
    cpName: cpNameRaw === '' ? null : cpNameRaw,
    currencyCode: currency,
    taxableBase: new Prisma.Decimal(baseRaw),
    igv: new Prisma.Decimal(igvRaw),
    total: new Prisma.Decimal(totalRaw),
  };
}

/**
 * Parsea y valida un archivo DEMO_V1 completo. Todo o nada: si CUALQUIER
 * fila es inválida no se devuelve ninguna. Función pura, sin persistencia.
 */
export function parseDemoProposal(
  input: Buffer | string,
  options: DemoProposalParseOptions = {},
): DemoProposalParseResult {
  const errors = new ErrorCollector();
  const fail = (): DemoProposalParseResult => ({
    ok: false,
    errors: errors.errors,
    totalErrors: errors.total,
  });

  const size =
    typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.length;
  if (size > SIRE_DEMO_MAX_FILE_BYTES) {
    errors.add(
      0,
      'file',
      'FILE_TOO_LARGE',
      `El archivo supera el máximo de ${SIRE_DEMO_MAX_FILE_BYTES} bytes.`,
    );
    return fail();
  }

  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      errors.add(
        0,
        'file',
        'NOT_UTF8',
        'El archivo debe ser texto UTF-8 válido.',
      );
      return fail();
    }
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  if (text.includes('\u0000')) {
    errors.add(
      0,
      'file',
      'BINARY_CONTENT',
      'El archivo contiene bytes nulos: no es un .txt de texto.',
    );
    return fail();
  }

  const lines = text
    .split('\n')
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    errors.add(0, 'file', 'EMPTY_FILE', 'El archivo está vacío.');
    return fail();
  }

  const header = parseHeader(lines[0], errors, options.expected);
  if (header === null) {
    return fail();
  }

  if (lines[1] !== DEMO_V1_COLUMNS_LINE) {
    errors.add(
      2,
      'columns',
      'INVALID_COLUMNS',
      `La segunda línea debe ser exactamente: ${DEMO_V1_COLUMNS_LINE}`,
    );
    return fail();
  }

  const dataLines = lines.slice(2);
  if (dataLines.length === 0) {
    errors.add(0, 'file', 'NO_ROWS', 'El archivo no contiene filas de datos.');
    return fail();
  }
  if (dataLines.length > SIRE_DEMO_MAX_ROWS) {
    errors.add(
      0,
      'file',
      'MAX_ROWS_EXCEEDED',
      `El archivo supera el máximo de ${SIRE_DEMO_MAX_ROWS} filas.`,
    );
    return fail();
  }

  const rows: ProposalRow[] = [];
  dataLines.forEach((line, index) => {
    const fileLine = index + 3;
    if (line.length > SIRE_DEMO_MAX_LINE_LENGTH) {
      errors.add(
        fileLine,
        'line',
        'LINE_TOO_LONG',
        `La línea supera ${SIRE_DEMO_MAX_LINE_LENGTH} caracteres.`,
      );
      return;
    }
    if (line.trim() === '') {
      errors.add(
        fileLine,
        'line',
        'BLANK_LINE',
        'No se admiten líneas en blanco entre las filas.',
      );
      return;
    }
    const fields = line.split('|');
    if (fields.length !== DEMO_V1_COLUMNS.length) {
      errors.add(
        fileLine,
        'line',
        'ROW_FIELD_COUNT',
        `Se esperaban ${DEMO_V1_COLUMNS.length} campos y se encontraron ${fields.length}.`,
      );
      return;
    }
    const row = parseRow(fields, index + 1, fileLine, header.register, errors);
    if (row !== null) {
      rows.push(row);
    }
  });

  if (errors.total > 0) {
    return fail();
  }
  return { ok: true, header, rows };
}

/** Texto de cabecera DEMO_V1 (mismo formato que valida el parser). */
export function buildDemoHeaderLine(header: {
  source: SireSource;
  register: SireRegister;
  period: string;
  fixtureSetVersion: string | null;
}): string {
  const parts = [
    `#${SIRE_DEMO_FORMAT_VERSION}`,
    `SOURCE=${header.source}`,
    `REGISTER=${header.register}`,
    `PERIOD=${header.period}`,
  ];
  if (header.fixtureSetVersion !== null) {
    parts.push(`FIXTURE=${header.fixtureSetVersion}`);
  }
  return parts.join('|');
}

import { Prisma } from '@prisma/client';
import { isValidDateOnly } from '../common/date/business-date';
import { FieldBadRequestException } from '../common/errors/error-contract';

/**
 * Aritmética de monedas de las compras (R4). Todo en Prisma.Decimal exacto,
 * nunca Number. Convención ÚNICA de la tasa:
 *
 *   exchangeRate = unidades de moneda de la EMPRESA por 1 unidad de la moneda
 *   del documento (p. ej. USD 1000 × 3.70 = PEN 3700 con empresa en PEN).
 *
 * La moneda contable es siempre la de la empresa (CompanySettings.currencyCode).
 */

const ZERO = new Prisma.Decimal(0);
const ONE = new Prisma.Decimal(1);

export const EXCHANGE_RATE_MAX_DECIMALS = 8;
/** Tope de la tasa: DECIMAL(18,8) admite 10 enteros; se limita a un valor razonable. */
export const EXCHANGE_RATE_MAX = new Prisma.Decimal('1000000');
/** Precio unitario en moneda extranjera: hasta 6 decimales (DECIMAL(18,6)). */
export const FOREIGN_UNIT_COST_MAX_DECIMALS = 6;
/** Precio unitario en moneda de la empresa: 2 decimales (contrato anterior a R4). */
export const BASE_UNIT_COST_MAX_DECIMALS = 2;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Redondeo monetario del sistema: HALF_UP a 2 decimales. */
export function roundMoney(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Convierte un importe de la moneda del documento a la de la empresa. */
export function toBaseAmount(
  originalAmount: Prisma.Decimal,
  exchangeRate: Prisma.Decimal,
): Prisma.Decimal {
  return roundMoney(originalAmount.mul(exchangeRate));
}

export function normalizeCurrencyCode(
  raw: string | undefined | null,
  field: string,
): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const code = raw.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(code)) {
    throw new FieldBadRequestException({
      message: `${field} debe ser un código de moneda de 3 letras (ISO 4217)`,
      code: 'CURRENCY_CODE_FORMAT',
      field,
      type: 'FORMAT',
    });
  }
  return code;
}

export function parseExchangeRate(
  raw: string,
  field = 'exchangeRate',
): Prisma.Decimal {
  let rate: Prisma.Decimal;
  try {
    rate = new Prisma.Decimal(raw);
  } catch {
    throw new FieldBadRequestException({
      message: `${field} no es un decimal válido`,
      code: 'EXCHANGE_RATE_FORMAT',
      field,
      type: 'FORMAT',
    });
  }
  if (!rate.isFinite() || rate.lessThanOrEqualTo(0)) {
    throw new FieldBadRequestException({
      message: `${field} debe ser un decimal positivo`,
      code: 'EXCHANGE_RATE_NOT_POSITIVE',
      field,
      type: 'FORMAT',
    });
  }
  if (rate.decimalPlaces() > EXCHANGE_RATE_MAX_DECIMALS) {
    throw new FieldBadRequestException({
      message: `${field} admite como máximo ${EXCHANGE_RATE_MAX_DECIMALS} decimales`,
      code: 'EXCHANGE_RATE_PRECISION',
      field,
      type: 'FORMAT',
    });
  }
  if (rate.greaterThan(EXCHANGE_RATE_MAX)) {
    throw new FieldBadRequestException({
      message: `${field} excede el máximo permitido`,
      code: 'EXCHANGE_RATE_TOO_LARGE',
      field,
      type: 'FORMAT',
    });
  }
  return rate;
}

export interface CurrencyInput {
  currencyCode?: string;
  exchangeRate?: string;
  exchangeRateDate?: string;
}

export interface ResolvedCurrency {
  currencyCode: string;
  baseCurrencyCode: string;
  exchangeRate: Prisma.Decimal;
  /** YYYY-MM-DD */
  exchangeRateDate: string;
  isForeign: boolean;
}

/**
 * Resuelve moneda, tasa y fecha de tasa de un documento (factura o pago):
 *  - sin moneda => moneda de la empresa;
 *  - misma moneda => tasa 1 (enviar otra tasa es un error, nunca se ignora);
 *  - moneda distinta => tasa positiva OBLIGATORIA (manual por documento);
 *  - fecha de tasa: la indicada o `defaultDate`.
 */
export function resolveDocumentCurrency(
  input: CurrencyInput,
  baseCurrencyCode: string,
  defaultDate: string,
  fieldPrefix = '',
): ResolvedCurrency {
  const f = (name: string): string => `${fieldPrefix}${name}`;
  const currencyCode =
    normalizeCurrencyCode(input.currencyCode, f('currencyCode')) ??
    baseCurrencyCode;

  let exchangeRateDate = defaultDate;
  if (input.exchangeRateDate !== undefined) {
    if (!isValidDateOnly(input.exchangeRateDate)) {
      throw new FieldBadRequestException({
        message: `${f('exchangeRateDate')} debe ser una fecha real en formato YYYY-MM-DD`,
        code: 'EXCHANGE_RATE_DATE_FORMAT',
        field: f('exchangeRateDate'),
        type: 'FORMAT',
      });
    }
    exchangeRateDate = input.exchangeRateDate;
  }

  if (currencyCode === baseCurrencyCode) {
    if (input.exchangeRate !== undefined) {
      const given = parseExchangeRate(input.exchangeRate, f('exchangeRate'));
      if (!given.equals(ONE)) {
        throw new FieldBadRequestException({
          message: `Con la moneda de la empresa (${baseCurrencyCode}) el tipo de cambio es 1`,
          code: 'EXCHANGE_RATE_MUST_BE_ONE',
          field: f('exchangeRate'),
        });
      }
    }
    return {
      currencyCode,
      baseCurrencyCode,
      exchangeRate: ONE,
      exchangeRateDate,
      isForeign: false,
    };
  }

  if (input.exchangeRate === undefined) {
    throw new FieldBadRequestException({
      message: `El tipo de cambio es obligatorio cuando la moneda (${currencyCode}) difiere de la de la empresa (${baseCurrencyCode})`,
      code: 'EXCHANGE_RATE_REQUIRED',
      field: f('exchangeRate'),
      type: 'REQUIRED',
    });
  }
  return {
    currencyCode,
    baseCurrencyCode,
    exchangeRate: parseExchangeRate(input.exchangeRate, f('exchangeRate')),
    exchangeRateDate,
    isForeign: true,
  };
}

export interface LineOriginalAmounts {
  taxableBaseAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  creditableTaxAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

/**
 * Convierte cada COMPONENTE de una línea a la moneda de la empresa
 * (HALF_UP a 2 decimales) y deriva el total de línea como base + impuesto, de
 * modo que el total convertido siempre cuadra con sus componentes (la cabecera
 * es la suma de líneas convertidas: nunca difiere del asiento). El crédito
 * fiscal convertido nunca supera el impuesto convertido (el redondeo es
 * monótono).
 */
export function convertLineToBase(
  original: LineOriginalAmounts,
  exchangeRate: Prisma.Decimal,
): LineOriginalAmounts {
  const taxableBaseAmount = toBaseAmount(original.taxableBaseAmount, exchangeRate);
  const taxAmount = toBaseAmount(original.taxAmount, exchangeRate);
  let creditableTaxAmount = toBaseAmount(
    original.creditableTaxAmount,
    exchangeRate,
  );
  if (creditableTaxAmount.greaterThan(taxAmount)) {
    creditableTaxAmount = taxAmount;
  }
  return {
    taxableBaseAmount,
    taxAmount,
    creditableTaxAmount,
    lineTotal: taxableBaseAmount.plus(taxAmount),
  };
}

/** Reparte `total` en proporción a `weights`, con el residuo de redondeo en el último peso positivo. */
export function distributeProportionally(
  total: Prisma.Decimal,
  weights: Prisma.Decimal[],
): Prisma.Decimal[] {
  const weightSum = weights.reduce((sum, w) => sum.plus(w), ZERO);
  if (weights.length === 0 || weightSum.lessThanOrEqualTo(0)) {
    return weights.map(() => ZERO);
  }
  let lastPositive = -1;
  weights.forEach((w, i) => {
    if (w.greaterThan(0)) {
      lastPositive = i;
    }
  });
  const result: Prisma.Decimal[] = weights.map(() => ZERO);
  let assigned = ZERO;
  weights.forEach((weight, index) => {
    if (index === lastPositive || weight.lessThanOrEqualTo(0)) {
      return;
    }
    const part = roundMoney(total.mul(weight).dividedBy(weightSum));
    result[index] = part;
    assigned = assigned.plus(part);
  });
  result[lastPositive] = total.minus(assigned);
  return result;
}

export interface CarryingInput {
  /** Total de la factura en moneda de la empresa. */
  invoiceBaseTotal: Prisma.Decimal;
  /** Total de la factura en la moneda del documento. */
  invoiceOriginalTotal: Prisma.Decimal;
  /** Asignaciones ACTIVAS previas, en moneda del documento. */
  alreadyPaidOriginal: Prisma.Decimal;
  /** Valor en libros ya cancelado por esas asignaciones (moneda de la empresa). */
  alreadyCarryingBase: Prisma.Decimal;
  /** Esta asignación, en moneda del documento. */
  allocationOriginal: Prisma.Decimal;
}

/**
 * Valor en libros (moneda de la empresa, a la tasa histórica de la factura) que
 * cancela una asignación: proporcional a lo asignado; la asignación que SALDA la
 * factura toma exactamente el residuo (nunca queda un céntimo sin cancelar).
 */
export function computeCarryingBase(input: CarryingInput): Prisma.Decimal {
  const remainingOriginal = input.invoiceOriginalTotal.minus(
    input.alreadyPaidOriginal,
  );
  const remainingCarrying = input.invoiceBaseTotal.minus(
    input.alreadyCarryingBase,
  );
  if (input.allocationOriginal.greaterThanOrEqualTo(remainingOriginal)) {
    return remainingCarrying;
  }
  const proportional = roundMoney(
    input.invoiceBaseTotal
      .mul(input.allocationOriginal)
      .dividedBy(input.invoiceOriginalTotal),
  );
  return proportional.greaterThan(remainingCarrying)
    ? remainingCarrying
    : proportional;
}

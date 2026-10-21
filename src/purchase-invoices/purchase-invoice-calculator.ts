import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  AccountingSystemKey,
  PurchaseLineTaxBasis,
  PurchaseLineTaxCategory,
  PurchasePurpose,
  Prisma,
} from '@prisma/client';
import { AccountingLineInput } from '../accounting/types/accounting-line';

const ZERO = new Prisma.Decimal(0);
const ONE = new Prisma.Decimal(1);
const HALF_CENT = new Prisma.Decimal('0.005');
const ONE_CENT = new Prisma.Decimal('0.01');
const MAX_MONEY = new Prisma.Decimal('999999999999.99');
const MAX_QUANTITY = new Prisma.Decimal('99999999999.999');

/**
 * Mapeo FIJO de propósito de compra (dimensión B del blueprint de A5.2) a
 * la cuenta destino configurable que lo resuelve. El NOMBRE de cada
 * AccountingSystemKey identifica el propósito de compra — nunca impone un
 * tratamiento contable: si esa cuenta real es de tránsito o final es una
 * decisión de mapeo del contador (ver AccountingSystemKey en schema.prisma
 * y chart-of-accounts), nunca una regla codificada en este mapeo.
 */
export const PURCHASE_PURPOSE_TO_SYSTEM_KEY: Readonly<
  Record<PurchasePurpose, AccountingSystemKey>
> = {
  [PurchasePurpose.RESALE_INVENTORY]:
    AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
  [PurchasePurpose.INTERNAL_CONSUMPTION]:
    AccountingSystemKey.PURCHASE_INTERNAL_CONSUMPTION,
  [PurchasePurpose.FIXED_ASSET]: AccountingSystemKey.PURCHASE_FIXED_ASSET,
  [PurchasePurpose.OPERATING_EXPENSE]:
    AccountingSystemKey.PURCHASE_OPERATING_EXPENSE,
  [PurchasePurpose.OTHER]: AccountingSystemKey.PURCHASE_OTHER,
};

/**
 * ROUND_HALF_UP(numerator/divisor, 2) EXACTO — misma técnica y mismo motivo
 * que quote-calculator.ts (Fase 5/R2, privada ahí): la división de
 * Prisma.Decimal redondea internamente a 20 dígitos significativos, lo que
 * puede en teoría producir un doble redondeo cerca del límite de medio
 * céntimo; se verifica el candidato con multiplicaciones exactas (sin
 * división) y se corrige un céntimo si no es correcto. Implementación
 * propia, no importada: cada calculador de este dominio es dueño de sus
 * propias funciones puras (mismo criterio que accounting-calculator.ts/
 * payment-calculator.ts/receivable-calculator.ts/sale-calculator.ts/
 * quote-calculator.ts, todos archivos separados pese a compartir técnica).
 */
function roundHalfUpQuotient(
  numerator: Prisma.Decimal,
  divisor: Prisma.Decimal,
): Prisma.Decimal {
  let candidate = numerator
    .dividedBy(divisor)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  if (candidate.minus(HALF_CENT).mul(divisor).greaterThan(numerator)) {
    candidate = candidate.minus(ONE_CENT);
  } else if (
    candidate.plus(HALF_CENT).mul(divisor).lessThanOrEqualTo(numerator)
  ) {
    candidate = candidate.plus(ONE_CENT);
  }
  return candidate;
}

function assertMoneyWithinRange(value: Prisma.Decimal, label: string): void {
  if (value.lessThan(0) || value.greaterThan(MAX_MONEY)) {
    throw new BadRequestException(
      `El ${label} calculado excede la capacidad representable`,
    );
  }
}

function assertValidQuantity(value: Prisma.Decimal): void {
  if (
    !Prisma.Decimal.isDecimal(value) ||
    !value.isFinite() ||
    value.lessThanOrEqualTo(0) ||
    value.decimalPlaces() > 3
  ) {
    throw new BadRequestException(
      'quantity debe ser un decimal positivo con máximo 3 decimales',
    );
  }
  if (value.greaterThan(MAX_QUANTITY)) {
    throw new BadRequestException('quantity excede el máximo permitido');
  }
}

function assertValidUnitCost(value: Prisma.Decimal): void {
  if (
    !Prisma.Decimal.isDecimal(value) ||
    !value.isFinite() ||
    value.lessThan(0) ||
    value.decimalPlaces() > 2
  ) {
    throw new BadRequestException(
      'unitCost debe ser un decimal no negativo con máximo 2 decimales',
    );
  }
  if (value.greaterThan(MAX_MONEY)) {
    throw new BadRequestException('unitCost excede el máximo permitido');
  }
}

/**
 * Nunca inferido de taxCategory (corrección explícita de la revisión de
 * A5.2): cuánto de taxAmount se reconoce como crédito fiscal es un valor
 * propio que el llamador decide línea por línea — esta función solo
 * valida forma y el límite superior real (nunca más que el impuesto del
 * propio documento).
 */
function assertValidCreditableTaxAmount(
  value: Prisma.Decimal,
  taxAmount: Prisma.Decimal,
): void {
  if (
    !Prisma.Decimal.isDecimal(value) ||
    !value.isFinite() ||
    value.lessThan(0) ||
    value.decimalPlaces() > 2
  ) {
    throw new BadRequestException(
      'creditableTaxAmount debe ser un decimal no negativo con máximo 2 decimales',
    );
  }
  if (value.greaterThan(taxAmount)) {
    throw new BadRequestException(
      'creditableTaxAmount no puede superar el impuesto de la línea (taxAmount)',
    );
  }
}

export interface ComputePurchaseLineAmountsInput {
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  taxCategory: PurchaseLineTaxCategory;
  /** Obligatorio (no null) únicamente cuando taxCategory=TAXED; validado por el llamador. */
  taxBasis: PurchaseLineTaxBasis | null;
  /** Snapshot de CompanySettings.taxRate vigente; null si taxCategory≠TAXED. */
  taxRate: Prisma.Decimal | null;
  /** Monto crudo propuesto por el llamador (default 0 si se omite). */
  creditableTaxAmount: Prisma.Decimal;
}

export interface PurchaseLineAmounts {
  taxableBaseAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  creditableTaxAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

/**
 * Calcula los montos de UNA línea según su propia categoría/base tributaria
 * — nunca asume que toda la factura comparte un único tratamiento (revisión
 * de A5.2, punto 1). Reutiliza ÚNICAMENTE el criterio de redondeo de R2
 * (Prisma.Decimal, HALF_UP, 2 decimales) — nunca la fórmula completa de
 * calculateTaxInclusiveTotals(), que asume impuesto incluido para TODO el
 * documento: esa asunción no es válida aquí.
 *
 *   EXEMPT/UNAFFECTED/OTHER: taxableBaseAmount = lineTotal = quantity×unitCost;
 *     taxAmount = creditableTaxAmount = 0 (sin impuesto que declarar).
 *   TAXED + TAX_INCLUDED: grossAmount = quantity×unitCost YA incluye el
 *     impuesto; taxableBaseAmount = ROUND_HALF_UP(grossAmount/divisor, 2);
 *     taxAmount = grossAmount − taxableBaseAmount (residual, nunca
 *     taxableBase×tasa, por el mismo motivo que R2: el importe final debe
 *     coincidir exactamente).
 *   TAXED + TAX_EXCLUDED: grossAmount = quantity×unitCost ES la base;
 *     taxAmount = ROUND_HALF_UP(base×tasa/100, 2); lineTotal = base+impuesto.
 */
export function computePurchaseLineAmounts(
  input: ComputePurchaseLineAmountsInput,
): PurchaseLineAmounts {
  assertValidQuantity(input.quantity);
  assertValidUnitCost(input.unitCost);

  const grossAmount = input.quantity
    .mul(input.unitCost)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  assertMoneyWithinRange(grossAmount, 'importe de línea');

  let taxableBaseAmount: Prisma.Decimal;
  let taxAmount: Prisma.Decimal;

  if (input.taxCategory !== PurchaseLineTaxCategory.TAXED) {
    taxableBaseAmount = grossAmount;
    taxAmount = ZERO;
  } else {
    if (input.taxBasis === null || input.taxRate === null) {
      throw new BadRequestException(
        'taxBasis y la tasa de impuesto son obligatorios cuando taxCategory=TAXED',
      );
    }
    if (
      !Prisma.Decimal.isDecimal(input.taxRate) ||
      input.taxRate.lessThan(0) ||
      input.taxRate.greaterThan(100)
    ) {
      // CompanySettings ya garantiza 0-100 (CHECK company_settings_tax_rate):
      // fuera de rango aquí es un invariante interno roto, nunca un error
      // del cliente — mismo criterio que calculateTaxInclusiveTotals (R2).
      throw new InternalServerErrorException(
        'La tasa de impuesto configurada es inválida',
      );
    }
    if (input.taxBasis === PurchaseLineTaxBasis.TAX_INCLUDED) {
      const divisor = ONE.plus(input.taxRate.dividedBy(100));
      taxableBaseAmount = roundHalfUpQuotient(grossAmount, divisor);
      taxAmount = grossAmount.minus(taxableBaseAmount);
    } else {
      taxableBaseAmount = grossAmount;
      taxAmount = grossAmount
        .mul(input.taxRate)
        .dividedBy(100)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    }
  }

  const lineTotal = taxableBaseAmount.plus(taxAmount);

  assertMoneyWithinRange(taxableBaseAmount, 'base imponible de línea');
  assertMoneyWithinRange(taxAmount, 'impuesto de línea');
  assertMoneyWithinRange(lineTotal, 'total de línea');
  assertValidCreditableTaxAmount(input.creditableTaxAmount, taxAmount);

  return {
    taxableBaseAmount,
    taxAmount,
    creditableTaxAmount: input.creditableTaxAmount,
    lineTotal,
  };
}

export interface PurchaseInvoiceLineTotalsInput {
  taxableBaseAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

export interface PurchaseInvoiceTotals {
  subtotal: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
}

/**
 * Totales de cabecera: SIEMPRE una suma de las líneas ya calculadas — nunca
 * una tasa única aplicada al documento completo (revisión de A5.2, punto
 * 1: una factura puede mezclar líneas con tratamiento tributario distinto).
 */
export function calculatePurchaseInvoiceTotals(
  lines: ReadonlyArray<PurchaseInvoiceLineTotalsInput>,
): PurchaseInvoiceTotals {
  let subtotal = ZERO;
  let taxAmount = ZERO;
  let totalAmount = ZERO;
  for (const line of lines) {
    subtotal = subtotal.plus(line.taxableBaseAmount);
    taxAmount = taxAmount.plus(line.taxAmount);
    totalAmount = totalAmount.plus(line.lineTotal);
  }
  assertMoneyWithinRange(subtotal, 'subtotal de la factura');
  assertMoneyWithinRange(taxAmount, 'impuesto de la factura');
  assertMoneyWithinRange(totalAmount, 'total de la factura');
  return { subtotal, taxAmount, totalAmount };
}

export interface PurchaseRecognitionLineInput {
  purchasePurpose: PurchasePurpose;
  taxableBaseAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  creditableTaxAmount: Prisma.Decimal;
}

/**
 * Construye las líneas del asiento de reconocimiento de compra, agrupando
 * por destino (una línea de débito por cada PurchasePurpose distinto
 * presente — nunca una por línea de factura, mismo criterio de agregación
 * que buildSaleRecognitionLines()). La porción NO creditable del impuesto
 * (taxAmount − creditableTaxAmount) se absorbe dentro del costo de destino
 * de esa misma línea — nunca se postea como una pérdida separada ni se
 * descarta (revisión de A5.2, punto 1).
 *
 * Por construcción, el resultado SIEMPRE cuadra:
 *   Σ(destino) + Σcreditable = Σ[base+(tax−creditable)] + Σcreditable
 *                             = Σbase + Σtax = ΣlineTotal = totalPayable
 * así que assertLinesBalanced() en AccountingEngine nunca debería fallar
 * para una entrada bien formada — y si falla, es la defensa en profundidad
 * correcta contra un invariante roto, nunca un caso de negocio esperado.
 */
export function buildPurchaseRecognitionLines(
  lines: ReadonlyArray<PurchaseRecognitionLineInput>,
): AccountingLineInput[] {
  if (lines.length === 0) {
    throw new InternalServerErrorException(
      'Una factura de compra requiere al menos una línea para contabilizarse',
    );
  }

  const destinationTotals = new Map<AccountingSystemKey, Prisma.Decimal>();
  let totalCreditableTax = ZERO;
  let totalPayable = ZERO;

  for (const line of lines) {
    const nonCreditable = line.taxAmount.minus(line.creditableTaxAmount);
    const destinationAmount = line.taxableBaseAmount.plus(nonCreditable);
    const systemKey = PURCHASE_PURPOSE_TO_SYSTEM_KEY[line.purchasePurpose];
    destinationTotals.set(
      systemKey,
      (destinationTotals.get(systemKey) ?? ZERO).plus(destinationAmount),
    );
    totalCreditableTax = totalCreditableTax.plus(line.creditableTaxAmount);
    totalPayable = totalPayable
      .plus(line.taxableBaseAmount)
      .plus(line.taxAmount);
  }

  if (totalPayable.lessThanOrEqualTo(0)) {
    throw new InternalServerErrorException(
      'El total a pagar de la factura debe ser mayor que cero para contabilizarse',
    );
  }

  const result: AccountingLineInput[] = [];
  for (const [systemKey, amount] of destinationTotals) {
    if (amount.greaterThan(0)) {
      result.push({ systemKey, debitAmount: amount, creditAmount: ZERO });
    }
  }
  if (totalCreditableTax.greaterThan(0)) {
    result.push({
      systemKey: AccountingSystemKey.VAT_RECEIVABLE,
      debitAmount: totalCreditableTax,
      creditAmount: ZERO,
    });
  }
  result.push({
    systemKey: AccountingSystemKey.ACCOUNTS_PAYABLE,
    debitAmount: ZERO,
    creditAmount: totalPayable,
  });

  return result;
}

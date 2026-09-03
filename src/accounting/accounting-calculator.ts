import { InternalServerErrorException } from '@nestjs/common';
import {
  AccountingSystemKey,
  PaymentMethodAccountingDestination,
  Prisma,
} from '@prisma/client';
import {
  ACCOUNTING_DESCRIPTION_MAX_LENGTH,
  ACCOUNTING_DESTINATION_TO_SYSTEM_KEY,
} from './constants/accounting.constants';
import {
  AccountingLineInput,
  ResolvedAccountingLine,
} from './types/accounting-line';

const ZERO = new Prisma.Decimal(0);

/**
 * Regla de actividad económica (plan final aprobado, §3/§12): NO hay
 * actividad contable únicamente cuando los cuatro componentes son
 * exactamente cero. Una venta con descuento total (subtotal>0,
 * discountAmount=subtotal, total=0) SÍ tiene actividad — total=0 nunca es
 * sinónimo de "sin actividad". Reutilizada tanto para decidir si
 * postSaleRecognition postea algo como para decidir si la anulación de
 * venta debe intentar revertir un asiento ORIGINAL que, por diseño, nunca
 * existió.
 */
export function hasSaleEconomicActivity(
  subtotal: Prisma.Decimal,
  discountAmount: Prisma.Decimal,
  taxAmount: Prisma.Decimal,
  total: Prisma.Decimal,
): boolean {
  return !(
    subtotal.isZero() &&
    discountAmount.isZero() &&
    taxAmount.isZero() &&
    total.isZero()
  );
}

/**
 * Construye las líneas del asiento de reconocimiento de venta (plan final
 * aprobado, §2/§11). PURA: no consulta ninguna cuenta real, solo decide
 * qué systemKey participa y con qué monto. Nunca emite una línea de monto
 * cero (ninguna de las cuatro condiciones se evalúa como "> 0" nunca
 * ">= 0"). El llamador (AccountingEngine.postSaleRecognition) ya debe
 * haber verificado hasSaleEconomicActivity() antes de invocar esta función
 * con montos que produzcan al menos una línea; si accidentalmente se
 * invoca con los cuatro en cero, retorna un arreglo vacío (defensa en
 * profundidad, nunca confía ciegamente en el llamador).
 */
export function buildSaleRecognitionLines(
  subtotal: Prisma.Decimal,
  discountAmount: Prisma.Decimal,
  taxAmount: Prisma.Decimal,
  total: Prisma.Decimal,
): AccountingLineInput[] {
  const lines: AccountingLineInput[] = [];

  if (total.greaterThan(0)) {
    lines.push({
      systemKey: AccountingSystemKey.ACCOUNTS_RECEIVABLE,
      debitAmount: total,
      creditAmount: ZERO,
    });
  }
  if (discountAmount.greaterThan(0)) {
    lines.push({
      systemKey: AccountingSystemKey.DISCOUNTS,
      debitAmount: discountAmount,
      creditAmount: ZERO,
    });
  }
  if (subtotal.greaterThan(0)) {
    lines.push({
      systemKey: AccountingSystemKey.SALES_REVENUE,
      debitAmount: ZERO,
      creditAmount: subtotal,
    });
  }
  if (taxAmount.greaterThan(0)) {
    lines.push({
      systemKey: AccountingSystemKey.VAT_PAYABLE,
      debitAmount: ZERO,
      creditAmount: taxAmount,
    });
  }

  return lines;
}

/**
 * Construye las dos líneas del asiento de cobro de pago (plan final
 * aprobado, §4/§13; recableado en Ticket C, Bloque C3): Debe la cuenta de
 * cobro según `accountingDestination` (Caja/Bancos — mapeo fijo de solo 2
 * valores, nunca configurable por ADMIN), Haber Cuentas por cobrar, ambas
 * por exactamente Payment.amount. `accountingDestination` ya viene
 * RESUELTO por el llamador (PaymentEngine, desde el PaymentMethod dinámico
 * — ver su propio docblock): esta función nunca consulta PaymentMethod ni
 * conoce el concepto de "método de pago", solo el destino contable de 2
 * valores. Ningún pago con monto 0 puede existir (Fase 7 ya lo garantiza),
 * así que estas dos líneas siempre son positivas.
 */
export function buildPaymentCollectionLines(
  accountingDestination: PaymentMethodAccountingDestination,
  amount: Prisma.Decimal,
): AccountingLineInput[] {
  return [
    {
      systemKey: ACCOUNTING_DESTINATION_TO_SYSTEM_KEY[accountingDestination],
      debitAmount: amount,
      creditAmount: ZERO,
    },
    {
      systemKey: AccountingSystemKey.ACCOUNTS_RECEIVABLE,
      debitAmount: ZERO,
      creditAmount: amount,
    },
  ];
}

/**
 * Invierte exactamente cada línea de un asiento ORIGINAL para construir su
 * REVERSAL (plan final aprobado, §22): debit<->credit, mismo accountId. No
 * vuelve a resolver por systemKey — reutiliza el accountId ya persistido en
 * la línea original, así que la reversión es correcta incluso si el mapeo
 * método->cuenta cambiara en el futuro (Fase 10): la reversión de un cobro
 * histórico siempre revierte la cuenta que realmente se usó, nunca la que
 * el mapeo vigente indicaría hoy.
 */
export function invertResolvedLines(
  lines: ResolvedAccountingLine[],
): ResolvedAccountingLine[] {
  return lines.map((line) => ({
    accountId: line.accountId,
    debitAmount: line.creditAmount,
    creditAmount: line.debitAmount,
  }));
}

/**
 * Valida el invariante de cuadre ANTES de que AccountingEngine intente
 * persistir nada (plan final aprobado, §14/§16): al menos 2 líneas, cada
 * línea con EXACTAMENTE un lado positivo (nunca 0/0, nunca ambos
 * positivos), total debit > 0, total credit > 0, y
 * SUM(debit) == SUM(credit). Esto es un invariante INTERNO — nunca una
 * entrada malformada del cliente (no existe HTTP todavía, y aunque
 * existiera, el cliente jamás construye líneas) — así que cualquier
 * violación es corrupción de lógica interna: InternalServerErrorException,
 * nunca una excepción de negocio 400/409. La base de datos NO puede
 * garantizar este cuadre cruzado entre filas (solo cada línea es válida
 * por sí sola vía CHECK); esta función es la única autoridad real.
 */
export function assertLinesBalanced(
  lines: ReadonlyArray<{
    debitAmount: Prisma.Decimal;
    creditAmount: Prisma.Decimal;
  }>,
): { totalDebit: Prisma.Decimal; totalCredit: Prisma.Decimal } {
  if (lines.length < 2) {
    throw new InternalServerErrorException(
      'Un asiento contable requiere al menos dos líneas',
    );
  }

  let totalDebit = ZERO;
  let totalCredit = ZERO;

  for (const line of lines) {
    const debitPositive = line.debitAmount.greaterThan(0);
    const creditPositive = line.creditAmount.greaterThan(0);
    if (debitPositive === creditPositive) {
      // Ambos false (línea 0/0) o ambos true (ambos lados positivos): en
      // cualquier caso, la línea no tiene exactamente un lado positivo.
      throw new InternalServerErrorException(
        'Cada línea contable debe tener exactamente un lado positivo',
      );
    }
    if (line.debitAmount.lessThan(0) || line.creditAmount.lessThan(0)) {
      throw new InternalServerErrorException(
        'Ninguna línea contable puede tener un monto negativo',
      );
    }
    totalDebit = totalDebit.plus(line.debitAmount);
    totalCredit = totalCredit.plus(line.creditAmount);
  }

  if (totalDebit.lessThanOrEqualTo(0) || totalCredit.lessThanOrEqualTo(0)) {
    throw new InternalServerErrorException(
      'El asiento contable debe tener montos totales positivos',
    );
  }
  if (!totalDebit.equals(totalCredit)) {
    throw new InternalServerErrorException(
      'El asiento contable no está cuadrado: el total debe no coincide con el total haber',
    );
  }

  return { totalDebit, totalCredit };
}

/** Backend-only, determinista, sin datos del cliente ni PII (plan final aprobado, §15). */
export function buildSaleOriginalDescription(saleNumber: string): string {
  return `Venta ${saleNumber}`;
}

export function buildPaymentOriginalDescription(saleNumber: string): string {
  return `Cobro de venta ${saleNumber}`;
}

export function buildSaleReversalDescription(saleNumber: string): string {
  return `Reversión de venta ${saleNumber}`;
}

export function buildPaymentReversalDescription(saleNumber: string): string {
  return `Reversión de cobro de venta ${saleNumber}`;
}

/**
 * Defensa en profundidad (mismo criterio que StockMovementEngine con
 * reason/notes): aunque la descripción SIEMPRE la genera el backend a
 * partir de las cuatro plantillas de arriba, nunca el cliente, el motor
 * la revalida igual antes de persistir — trimmed, no vacía, <=200
 * (accounting_entries_description_not_blank y la longitud de columna,
 * migration.sql de la Fase 8, Bloque A).
 */
export function assertValidAccountingDescription(description: string): void {
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    throw new InternalServerErrorException(
      'La descripción del asiento contable no puede estar vacía',
    );
  }
  if (trimmed.length > ACCOUNTING_DESCRIPTION_MAX_LENGTH) {
    throw new InternalServerErrorException(
      `La descripción del asiento contable no puede superar los ${ACCOUNTING_DESCRIPTION_MAX_LENGTH} caracteres`,
    );
  }
}

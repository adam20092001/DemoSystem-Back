import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, QuoteStatus } from '@prisma/client';
import { isExpired } from '../common/date/business-date';

/** Máximo representable en Decimal(14,3): 11 enteros + 3 decimales. */
const MAX_QUANTITY = new Prisma.Decimal('99999999999.999');

/** Máximo representable en Decimal(14,2): 12 enteros + 2 decimales. */
const MAX_MONEY = new Prisma.Decimal('999999999999.99');

/**
 * Forma textual estricta: solo dígitos, sin signo, sin notación científica.
 * Mismo criterio que STOCK_QUANTITY_PATTERN (Productos) e
 * INVENTORY_QUANTITY_PATTERN (Inventario): un string como "1e3" es un
 * Decimal válido para decimal.js, pero no es una forma de cantidad/monto
 * aceptable proveniente de un DTO HTTP.
 */
const QUANTITY_PATTERN = /^\d{1,11}(\.\d{1,3})?$/;
const DISCOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/** IGV siempre 0.00 en la Fase 5 (D5): configuración de impuestos llega en la Fase 10. */
export const QUOTE_TAX_AMOUNT: Prisma.Decimal = new Prisma.Decimal(0);

/**
 * Parsea y valida la cantidad de un ítem. Nunca confía en que el llamador
 * (DTO HTTP o input interno) ya la validó. Nunca usa Number()/parseFloat():
 * todo con Prisma.Decimal.
 */
export function parseQuantity(raw: string): Prisma.Decimal {
  if (typeof raw !== 'string' || !QUANTITY_PATTERN.test(raw)) {
    throw new BadRequestException(
      'La cantidad debe ser un decimal no negativo, como texto, con máximo 3 decimales',
    );
  }
  const quantity = new Prisma.Decimal(raw);
  if (quantity.lessThanOrEqualTo(0)) {
    throw new BadRequestException('La cantidad debe ser mayor que cero');
  }
  if (quantity.greaterThan(MAX_QUANTITY)) {
    throw new BadRequestException('La cantidad excede el máximo permitido');
  }
  return quantity;
}

/** Si la unidad no admite decimales, la cantidad debe ser entera por valor. */
export function assertQuantityAllowedForUnit(
  quantity: Prisma.Decimal,
  allowDecimal: boolean,
): void {
  if (!allowDecimal && !quantity.isInteger()) {
    throw new BadRequestException(
      'La unidad del producto no admite cantidades fraccionarias',
    );
  }
}

/** Ausente -> 0.00 (sin descuento). Presente -> validado como Decimal(14,2) no negativo. */
export function parseDiscountAmount(raw?: string): Prisma.Decimal {
  if (raw === undefined) {
    return new Prisma.Decimal(0);
  }
  if (typeof raw !== 'string' || !DISCOUNT_PATTERN.test(raw)) {
    throw new BadRequestException(
      'El descuento debe ser un decimal no negativo, como texto, con máximo 2 decimales',
    );
  }
  const discount = new Prisma.Decimal(raw);
  if (discount.greaterThan(MAX_MONEY)) {
    throw new BadRequestException('El descuento excede el máximo permitido');
  }
  return discount;
}

function assertMoneyWithinRange(value: Prisma.Decimal, label: string): void {
  // Un valor negativo o desbordado aquí sería un invariante interno roto
  // (las validaciones de entrada ya garantizan quantity>0, unitPrice>=0,
  // discount<=subtotal), nunca un error del cliente: 409, no 400, igual
  // que el desbordamiento de stock en StockMovementEngine.
  if (value.lessThan(0) || value.greaterThan(MAX_MONEY)) {
    throw new ConflictException(
      `El ${label} calculado excede la capacidad representable`,
    );
  }
}

/** lineTotal = round(quantity * unitPrice, 2), redondeo HALF_UP (coincide con ROUND() de PostgreSQL). */
export function calculateLineTotal(
  quantity: Prisma.Decimal,
  unitPrice: Prisma.Decimal,
): Prisma.Decimal {
  const lineTotal = quantity
    .mul(unitPrice)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  assertMoneyWithinRange(lineTotal, 'total de línea');
  return lineTotal;
}

/** Suma de lineTotal YA redondeados (no se redondea de nuevo al sumar). */
export function calculateSubtotal(
  lineTotals: Prisma.Decimal[],
): Prisma.Decimal {
  const subtotal = lineTotals.reduce(
    (accumulated, lineTotal) => accumulated.plus(lineTotal),
    new Prisma.Decimal(0),
  );
  assertMoneyWithinRange(subtotal, 'subtotal');
  return subtotal;
}

/** El descuento nunca puede exceder el subtotal (evita un total negativo). */
export function assertDiscountWithinSubtotal(
  discountAmount: Prisma.Decimal,
  subtotal: Prisma.Decimal,
): void {
  if (discountAmount.greaterThan(subtotal)) {
    throw new BadRequestException('El descuento no puede superar el subtotal');
  }
}

/** total = subtotal - discountAmount + taxAmount. */
export function calculateTotal(
  subtotal: Prisma.Decimal,
  discountAmount: Prisma.Decimal,
  taxAmount: Prisma.Decimal,
): Prisma.Decimal {
  const total = subtotal.minus(discountAmount).plus(taxAmount);
  assertMoneyWithinRange(total, 'total');
  return total;
}

/**
 * Estado efectivo: EXPIRED es derivado, nunca persistido por la Fase 5.
 * REJECTED/CONVERTED son terminales sin importar la fecha. PENDING/ACCEPTED
 * se reinterpretan como EXPIRED cuando expirationDate < businessDate.
 */
export function effectiveStatus(
  storedStatus: QuoteStatus,
  expirationDate: Date | string,
  businessDate: string,
): QuoteStatus {
  if (storedStatus === QuoteStatus.EXPIRED) {
    return QuoteStatus.EXPIRED;
  }
  if (storedStatus === QuoteStatus.REJECTED) {
    return QuoteStatus.REJECTED;
  }
  if (storedStatus === QuoteStatus.CONVERTED) {
    return QuoteStatus.CONVERTED;
  }
  // PENDING o ACCEPTED.
  if (isExpired(expirationDate, businessDate)) {
    return QuoteStatus.EXPIRED;
  }
  return storedStatus;
}

function assertEffectivePending(
  effective: QuoteStatus,
  conflictMessage: string,
): void {
  if (effective !== QuoteStatus.PENDING) {
    throw new ConflictException(conflictMessage);
  }
}

/** Solo una cotización con estado efectivo PENDING es editable. */
export function assertEditable(effective: QuoteStatus): void {
  assertEffectivePending(
    effective,
    'Solo una cotización pendiente puede editarse',
  );
}

/** PENDING -> ACCEPTED es la única transición válida de aceptación. */
export function assertAcceptable(effective: QuoteStatus): void {
  assertEffectivePending(
    effective,
    'Solo una cotización pendiente puede aceptarse',
  );
}

/** PENDING -> REJECTED es la única transición válida de rechazo. */
export function assertRejectable(effective: QuoteStatus): void {
  assertEffectivePending(
    effective,
    'Solo una cotización pendiente puede rechazarse',
  );
}

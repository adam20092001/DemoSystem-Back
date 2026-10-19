import { BadRequestException, ConflictException } from '@nestjs/common';
import { LineDiscountType, Prisma, QuoteStatus } from '@prisma/client';
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

/**
 * NR-03: descuento individual de línea (independiente del descuento de
 * documento, que se sigue aplicando ADICIONALMENTE sobre Σ lineTotal —
 * ver assertCombinedDiscountWithinConfiguredLimit()). PURA: solo
 * Prisma.Decimal, sin acceso a base de datos.
 */
export interface LineDiscountInput {
  discountType?: LineDiscountType;
  /** Texto crudo del DTO: soles si FIXED, 0-100 si PERCENT. */
  discountValue?: string;
}

export interface ParsedLineDiscount {
  discountType: LineDiscountType | null;
  discountValue: Prisma.Decimal | null;
}

/**
 * Valida presencia conjunta (ambos u ninguno — nunca uno solo) y la forma
 * del valor. Nunca decide si el valor es válido para su tipo (0-100 para
 * PERCENT, ≤ bruto de línea para FIXED): eso depende del lineTotal de esa
 * línea, que este parser todavía no conoce — lo hace
 * calculateLineDiscount(), ya con el bruto calculado.
 */
export function parseLineDiscount(
  input: LineDiscountInput,
): ParsedLineDiscount {
  const hasType = input.discountType !== undefined;
  const hasValue = input.discountValue !== undefined;
  if (hasType !== hasValue) {
    throw new BadRequestException(
      'discountType y discountValue deben proveerse juntos: ambos presentes o ambos ausentes',
    );
  }
  if (!hasType) {
    return { discountType: null, discountValue: null };
  }
  if (
    typeof input.discountValue !== 'string' ||
    !DISCOUNT_PATTERN.test(input.discountValue)
  ) {
    throw new BadRequestException(
      'discountValue debe ser un decimal no negativo, como texto, con máximo 2 decimales',
    );
  }
  const discountValue = new Prisma.Decimal(input.discountValue);
  if (discountValue.greaterThan(MAX_MONEY)) {
    throw new BadRequestException('discountValue excede el máximo permitido');
  }
  return {
    discountType: input.discountType as LineDiscountType,
    discountValue,
  };
}

/** rawLineTotal de una línea, ANTES de su propio descuento: ROUND(quantity*unitPrice,2). */
export function calculateRawLineTotal(
  quantity: Prisma.Decimal,
  unitPrice: Prisma.Decimal,
): Prisma.Decimal {
  return calculateLineTotal(quantity, unitPrice);
}

export interface LineDiscountResult {
  discountType: LineDiscountType | null;
  discountValue: Prisma.Decimal | null;
  /** Siempre en soles, ya calculado; 0 cuando discountType es null. */
  discountAmount: Prisma.Decimal;
  /** rawLineTotal - discountAmount. Idéntico a rawLineTotal sin descuento. */
  lineTotal: Prisma.Decimal;
}

/**
 * Aplica el descuento de línea ya parseado (parseLineDiscount()) sobre el
 * bruto de ESA línea. maxDiscountPercent (CompanySettings, Fase 10, Bloque
 * B) limita el descuento EFECTIVO de la línea sin importar si se expresó
 * en soles o porcentaje — un FIXED que equivalga a más del porcentaje
 * configurado se rechaza igual que un PERCENT explícito fuera de rango,
 * con el mismo criterio de comparación cruzada por multiplicación que
 * assertDiscountWithinConfiguredLimit() (nunca dividir ni redondear un
 * "máximo permitido" intermedio).
 */
export function calculateLineDiscount(
  rawLineTotal: Prisma.Decimal,
  parsed: ParsedLineDiscount,
  maxDiscountPercent: Prisma.Decimal,
): LineDiscountResult {
  if (parsed.discountType === null || parsed.discountValue === null) {
    return {
      discountType: null,
      discountValue: null,
      discountAmount: new Prisma.Decimal(0),
      lineTotal: rawLineTotal,
    };
  }

  let discountAmount: Prisma.Decimal;
  if (parsed.discountType === LineDiscountType.FIXED) {
    if (
      parsed.discountValue.lessThan(0) ||
      parsed.discountValue.greaterThan(rawLineTotal)
    ) {
      throw new BadRequestException(
        'El descuento fijo de línea no puede ser negativo ni superar el importe bruto de la línea',
      );
    }
    discountAmount = parsed.discountValue;
  } else {
    if (
      parsed.discountValue.lessThan(0) ||
      parsed.discountValue.greaterThan(100)
    ) {
      throw new BadRequestException(
        'El descuento porcentual de línea debe estar entre 0 y 100',
      );
    }
    discountAmount = rawLineTotal
      .mul(parsed.discountValue)
      .dividedBy(100)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }

  if (
    discountAmount.mul(100).greaterThan(rawLineTotal.mul(maxDiscountPercent))
  ) {
    throw new BadRequestException(
      'El descuento de línea supera el porcentaje máximo permitido por la configuración de la empresa',
    );
  }

  const lineTotal = rawLineTotal.minus(discountAmount);
  assertMoneyWithinRange(lineTotal, 'total de línea');

  return {
    discountType: parsed.discountType,
    discountValue: parsed.discountValue,
    discountAmount,
    lineTotal,
  };
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

/**
 * Invariante de descuento máximo CONFIGURADO (Fase 10, Bloque B):
 * discountAmount * 100 <= subtotal * maxDiscountPercent. Comparación
 * cruzada por multiplicación, sin dividir ni redondear un "monto máximo
 * permitido" intermedio (evitaría introducir un error de redondeo que no
 * existe en los datos de entrada). Pura: únicamente Prisma.Decimal, sin
 * Number()/parseFloat() ni aritmética de punto flotante de JS.
 *
 * Complementa a assertDiscountWithinSubtotal() (invariante absoluta,
 * siempre 0 <= discountAmount <= subtotal); esta es la invariante adicional
 * y configurable. Cuando subtotal = 0, discountAmount ya debe ser 0 por la
 * invariante absoluta, así que 0*100 <= 0*maxDiscountPercent siempre se
 * cumple trivialmente — sin necesidad de un caso especial.
 *
 * Única fuente de verdad reutilizada por Quotes y Sales (sale-calculator.ts
 * la reexporta, mismo criterio que el resto de primitivas compartidas de
 * este archivo): nunca se duplica una fórmula de porcentaje sutilmente
 * distinta en cada dominio.
 */
export function assertDiscountWithinConfiguredLimit(
  discountAmount: Prisma.Decimal,
  subtotal: Prisma.Decimal,
  maxDiscountPercent: Prisma.Decimal,
): void {
  if (discountAmount.mul(100).greaterThan(subtotal.mul(maxDiscountPercent))) {
    throw new BadRequestException(
      'El descuento supera el porcentaje máximo permitido por la configuración de la empresa',
    );
  }
}

/**
 * NR-03: límite configurado aplicado al descuento EFECTIVO COMBINADO
 * (línea + documento), contra el bruto ORIGINAL del documento (Σ
 * rawLineTotal, antes de cualquier descuento de línea) — nunca contra el
 * subtotal ya descontado por línea. Complementa, no sustituye, a
 * assertDiscountWithinConfiguredLimit() (que sigue acotando el descuento
 * de DOCUMENTO por sí solo contra itemsTotal, el subtotal ya descontado
 * por línea): si cada línea ya respeta su propio límite individual
 * (calculateLineDiscount()), la suma de descuentos de línea respeta
 * trivialmente este mismo límite por sí sola (la desigualdad se preserva
 * al sumar); esta función es la que impide que el descuento de documento,
 * sumado ENCIMA de los de línea, termine superando en conjunto el
 * porcentaje máximo real de la empresa — el bypass que un descuento
 * repartido entre líneas y documento podría lograr si solo se validara
 * cada pieza por separado contra su propia base relativa.
 */
export function assertCombinedDiscountWithinConfiguredLimit(
  grossTotal: Prisma.Decimal,
  total: Prisma.Decimal,
  maxDiscountPercent: Prisma.Decimal,
): void {
  const effectiveDiscount = grossTotal.minus(total);
  if (
    effectiveDiscount.mul(100).greaterThan(grossTotal.mul(maxDiscountPercent))
  ) {
    throw new BadRequestException(
      'El descuento combinado (por línea y general) supera el porcentaje máximo permitido por la configuración de la empresa',
    );
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
 * Base imponible del IGV (Fase 10, Bloque C): taxableBase = subtotal -
 * discountAmount. Nunca negativa en la práctica: assertDiscountWithinSubtotal
 * ya garantiza discountAmount <= subtotal antes de que cualquier llamador
 * invoque esto. Extraída como función propia (en vez de inline en cada
 * llamador) porque tres sitios distintos la necesitan (creación de Quote,
 * actualización comercial de Quote, creación directa de Sale) y debe ser
 * exactamente la misma fórmula en los tres.
 */
export function calculateTaxableBase(
  subtotal: Prisma.Decimal,
  discountAmount: Prisma.Decimal,
): Prisma.Decimal {
  return subtotal.minus(discountAmount);
}

/**
 * IGV a nivel de DOCUMENTO (Fase 10, Bloque C — Product.salePrice/
 * lineTotal/subtotal siguen siendo SIEMPRE antes de impuesto; esta función
 * nunca se invoca por ítem). taxEnabled=false -> 0.00 sin importar taxRate
 * (nunca se lee ni se usa). taxEnabled=true -> ROUND(taxableBase * taxRate
 * / 100, 2), redondeo ÚNICO HALF_UP (mismo criterio que calculateLineTotal:
 * coincide con ROUND() de PostgreSQL, nunca el redondeo de punto flotante
 * de JS). Pura: solo Prisma.Decimal, sin PrismaService/SettingsReader/
 * inyección de Nest — única fuente de verdad reutilizada por Quotes y Sales
 * (sale-calculator.ts la reexporta, mismo criterio que
 * assertDiscountWithinConfiguredLimit).
 */
export function calculateTaxAmount(
  taxableBase: Prisma.Decimal,
  taxEnabled: boolean,
  taxRate: Prisma.Decimal,
): Prisma.Decimal {
  if (!taxEnabled) {
    return new Prisma.Decimal(0);
  }
  const taxAmount = taxableBase
    .mul(taxRate)
    .dividedBy(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  assertMoneyWithinRange(taxAmount, 'impuesto');
  return taxAmount;
}

/** Montos de un documento calculado con precios FINALES (IGV incluido cuando aplica). */
export interface TaxInclusiveTotals {
  /** Σ lineTotal: suma de líneas a precio final de catálogo (con IGV). */
  itemsTotal: Prisma.Decimal;
  /** Persistible: taxableBase + discountAmount (antes de impuesto). */
  subtotal: Prisma.Decimal;
  /** Persistible: descuento del cliente expresado antes de impuesto. */
  discountAmount: Prisma.Decimal;
  /** IGV contenido en `total`, por residuo (total - taxableBase). */
  taxAmount: Prisma.Decimal;
  /** Base imponible: subtotal - discountAmount. */
  taxableBase: Prisma.Decimal;
  /** Importe a pagar: itemsTotal - customerDiscount (exacto, sin redondeo). */
  total: Prisma.Decimal;
}

export interface TaxInclusiveTotalsInput {
  /**
   * lineTotal de cada ítem YA con su propio descuento de línea aplicado
   * (calculateLineDiscount(), o el lineTotal bruto si la línea no tiene
   * descuento) — nunca el bruto sin descontar.
   */
  lineTotals: readonly Prisma.Decimal[];
  /**
   * NR-03: lineTotal BRUTO de cada ítem (antes de su descuento de línea),
   * en el MISMO orden que `lineTotals`. Ausente -> se asume idéntico a
   * `lineTotals` (ningún ítem tiene descuento de línea, el caso de
   * siempre): assertCombinedDiscountWithinConfiguredLimit() se reduce
   * entonces exactamente a lo que ya validaba
   * assertDiscountWithinConfiguredLimit(), sin cambiar ningún resultado
   * para un llamador que no usa descuentos de línea (p. ej. SalesService
   * createDirect, que nunca los tiene).
   */
  grossLineTotals?: readonly Prisma.Decimal[];
  /** Descuento de documento sobre el importe FINAL (lo que ve el cliente). */
  customerDiscount: Prisma.Decimal;
  taxEnabled: boolean;
  taxRate: Prisma.Decimal;
  maxDiscountPercent: Prisma.Decimal;
}

const HALF_CENT = new Prisma.Decimal('0.005');
const ONE_CENT = new Prisma.Decimal('0.01');

/**
 * ROUND_HALF_UP(numerator / divisor, 2) EXACTO. La división de Prisma.Decimal
 * redondea internamente a 20 dígitos significativos; con importes de hasta
 * 12 enteros un cociente periódico podría, en teoría, cruzar el límite de
 * medio céntimo antes del redondeo final (doble redondeo). Por eso el
 * candidato se verifica con multiplicaciones exactas (sin división):
 * b es correcto ⇔ (b - 0.005)·d ≤ numerador < (b + 0.005)·d (d > 0), y se
 * corrige un céntimo si no lo es.
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

function assertMoneyShape(value: Prisma.Decimal, label: string): void {
  // Los lineTotal ya vienen de calculateLineTotal(): una forma inválida aquí
  // es un invariante interno roto (409), no un error del cliente.
  if (
    !Prisma.Decimal.isDecimal(value) ||
    !value.isFinite() ||
    value.decimalPlaces() > 2
  ) {
    throw new ConflictException(`El ${label} no es un monto válido`);
  }
  assertMoneyWithinRange(value, label);
}

/**
 * R2: montos de un documento cuyos precios de catálogo son FINALES (incluyen
 * IGV cuando aplica). Nunca suma IGV encima: lo DESGLOSA del importe a
 * pagar. PURA: solo Prisma.Decimal, sin base de datos ni inyección de Nest.
 *
 *   itemsTotal     = Σ lineTotal
 *   total          = itemsTotal - customerDiscount          (exacto)
 *   divisor        = taxEnabled ? 1 + taxRate/100 : 1
 *   taxableBase    = ROUND_HALF_UP(total / divisor, 2)       (a nivel de DOCUMENTO)
 *   taxAmount      = total - taxableBase                     (por residuo)
 *   discountAmount = ROUND_HALF_UP(customerDiscount / divisor, 2)
 *   subtotal       = taxableBase + discountAmount
 *
 * Por construcción: total = subtotal - discountAmount + taxAmount,
 * taxableBase = subtotal - discountAmount, y ningún monto es negativo
 * (taxableBase ≤ total porque total ya es un múltiplo exacto de 0.01 ≥
 * total/divisor). Así se cumplen las CHECK actuales de cabecera sin
 * modificarlas. El IGV se obtiene por residuo — nunca taxableBase × tasa —
 * para que el importe a pagar sea EXACTAMENTE el precio final (10.00 →
 * base 8.47 + IGV 1.53, nunca 8.47 × 1.18 = 9.99).
 *
 * El descuento conserva las reglas existentes, evaluadas sobre el importe
 * FINAL que ve el cliente: assertDiscountWithinSubtotal() (nunca mayor que
 * itemsTotal) y assertDiscountWithinConfiguredLimit() (porcentaje máximo
 * configurado) — mismas funciones y mensajes, sin reglas nuevas.
 *
 * Invocada por QuotesService (creación y edición) y SalesService (venta
 * directa). NR-03: `grossLineTotals`, si se provee, habilita además
 * assertCombinedDiscountWithinConfiguredLimit() (descuento de línea +
 * documento, contra el bruto original) — ver su docblock.
 */
export function calculateTaxInclusiveTotals(
  input: TaxInclusiveTotalsInput,
): TaxInclusiveTotals {
  input.lineTotals.forEach((lineTotal) =>
    assertMoneyShape(lineTotal, 'total de línea'),
  );

  const { customerDiscount, taxEnabled, taxRate, maxDiscountPercent } = input;
  if (
    !Prisma.Decimal.isDecimal(customerDiscount) ||
    !customerDiscount.isFinite() ||
    customerDiscount.lessThan(0) ||
    customerDiscount.decimalPlaces() > 2
  ) {
    throw new BadRequestException(
      'El descuento debe ser un decimal no negativo con máximo 2 decimales',
    );
  }
  if (
    taxEnabled &&
    (!Prisma.Decimal.isDecimal(taxRate) ||
      taxRate.lessThan(0) ||
      taxRate.greaterThan(100))
  ) {
    // CompanySettings ya garantiza 0-100 (CHECK company_settings_tax_rate):
    // fuera de rango aquí es un invariante interno roto.
    throw new ConflictException('La tasa de impuesto configurada es inválida');
  }

  const itemsTotal = calculateSubtotal([...input.lineTotals]);
  assertDiscountWithinSubtotal(customerDiscount, itemsTotal);
  assertDiscountWithinConfiguredLimit(
    customerDiscount,
    itemsTotal,
    maxDiscountPercent,
  );

  const total = itemsTotal.minus(customerDiscount);

  const grossTotal = input.grossLineTotals
    ? calculateSubtotal([...input.grossLineTotals])
    : itemsTotal;
  assertCombinedDiscountWithinConfiguredLimit(
    grossTotal,
    total,
    maxDiscountPercent,
  );

  const divisor = taxEnabled
    ? new Prisma.Decimal(1).plus(taxRate.dividedBy(100))
    : new Prisma.Decimal(1);

  const taxableBase = roundHalfUpQuotient(total, divisor);
  const taxAmount = total.minus(taxableBase);
  const discountAmount = roundHalfUpQuotient(customerDiscount, divisor);
  const subtotal = taxableBase.plus(discountAmount);

  assertMoneyWithinRange(subtotal, 'subtotal');
  assertMoneyWithinRange(taxAmount, 'impuesto');
  assertMoneyWithinRange(total, 'total');

  return {
    itemsTotal,
    subtotal,
    discountAmount,
    taxAmount,
    taxableBase,
    total,
  };
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

/**
 * Traduce un filtro de estado EFECTIVO solicitado (incluido EXPIRED, que
 * nunca se persiste) al predicado real sobre las columnas almacenadas
 * (status/expirationDate), usando la fecha de negocio America/Lima ya
 * calculada por el llamador — nunca CURRENT_DATE de PostgreSQL ni la fecha
 * local del servidor. Pura: sin PrismaService, sin inyección de
 * dependencias, sin acceso a base de datos — solo construye el fragmento
 * `Prisma.QuoteWhereInput` que el llamador combina en su propio `where`.
 *
 * Única fuente de verdad de esta traducción (Fase 9, remediación EXPIRED):
 * QuotesService, ReportsService y DashboardService la reutilizan sin
 * duplicarla — ninguno de los dos últimos importa QuotesModule ni inyecta
 * QuotesService; solo importan esta función pura del dominio Quote.
 *
 * REJECTED/CONVERTED son terminales: el filtro es una igualdad directa
 * sobre la columna, sin importar la fecha (igual que effectiveStatus()).
 * PENDING/ACCEPTED excluyen las cotizaciones vencidas (expirationDate <
 * fecha de negocio): esas ya pertenecen efectivamente a EXPIRED. El filtro
 * EXPIRED es un OR: nunca hay filas físicamente EXPIRED hoy, pero la
 * condición se mantiene correcta si una fase futura llegara a persistirlo.
 */
export function buildEffectiveQuoteStatusCondition(
  status: QuoteStatus,
  businessDateAsDate: Date,
): Prisma.QuoteWhereInput {
  switch (status) {
    case QuoteStatus.EXPIRED:
      return {
        OR: [
          { status: QuoteStatus.EXPIRED },
          {
            status: { in: [QuoteStatus.PENDING, QuoteStatus.ACCEPTED] },
            expirationDate: { lt: businessDateAsDate },
          },
        ],
      };
    case QuoteStatus.PENDING:
      return {
        status: QuoteStatus.PENDING,
        expirationDate: { gte: businessDateAsDate },
      };
    case QuoteStatus.ACCEPTED:
      return {
        status: QuoteStatus.ACCEPTED,
        expirationDate: { gte: businessDateAsDate },
      };
    case QuoteStatus.REJECTED:
      return { status: QuoteStatus.REJECTED };
    case QuoteStatus.CONVERTED:
      return { status: QuoteStatus.CONVERTED };
  }
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

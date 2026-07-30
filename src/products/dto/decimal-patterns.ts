/**
 * Decimal no negativo, sin signo, con hasta 2 decimales. Usado para
 * salePrice. Compartido entre Create/UpdateProductDto para no duplicar el
 * patrón. Rechaza números JavaScript: la validación exige que el valor sea
 * un string (@IsString()), aplicado junto a este patrón.
 */
export const SALE_PRICE_PATTERN = /^\d+(\.\d{1,2})?$/;

/** Decimal no negativo, hasta 3 decimales. Usado para stockMinimum. */
export const STOCK_QUANTITY_PATTERN = /^\d+(\.\d{1,3})?$/;

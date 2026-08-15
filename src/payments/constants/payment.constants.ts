/**
 * Longitudes alineadas exactamente con las columnas de `payments`
 * (Fase 7, Bloque A: prisma/schema.prisma + migration.sql). Sin lógica de
 * parsing/validación de negocio aquí — eso llega en el Bloque B
 * (PaymentEngine), igual que MAX_STOCK_VALUE/INVENTORY_QUANTITY_PATTERN
 * viven en Inventario pero la validación real vive en StockMovementEngine.
 */

/** payments.reference VARCHAR(100). */
export const PAYMENT_REFERENCE_MAX_LENGTH = 100;

/** payments.cancellation_reason VARCHAR(200), igual que sales.cancellation_reason. */
export const PAYMENT_CANCELLATION_REASON_MAX_LENGTH = 200;

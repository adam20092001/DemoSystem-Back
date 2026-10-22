/**
 * Longitudes alineadas con las columnas de `supplier_payments`/
 * `supplier_payment_allocations` (Fase A5.3, prisma/schema.prisma +
 * migration.sql). Sin lógica de parsing/validación de negocio aquí.
 */

/** supplier_payments.reference VARCHAR(100). */
export const SUPPLIER_PAYMENT_REFERENCE_MAX_LENGTH = 100;

/** supplier_payments.cancellation_reason VARCHAR(300), igual que purchase_receipts.cancellation_reason. */
export const SUPPLIER_PAYMENT_CANCELLATION_REASON_MAX_LENGTH = 300;

/**
 * Límite razonable de asignaciones por pago en un mismo lote (no es un
 * límite de columna): aplicado tanto por el DTO HTTP (ArrayMaxSize) como
 * por SupplierPaymentsService como defensa en profundidad.
 */
export const MAX_SUPPLIER_PAYMENT_ALLOCATIONS = 50;

import { Prisma } from '@prisma/client';

/**
 * Valor máximo representable en Decimal(14,3): 11 dígitos enteros + 3
 * decimales. Cualquier newStock que lo exceda debe rechazarse como error de
 * negocio controlado (Bloque B), nunca dejar que PostgreSQL lo rechace con
 * un "numeric field overflow" no controlado.
 */
export const MAX_STOCK_VALUE = new Prisma.Decimal('99999999999.999');

/**
 * Forma textual de una cantidad de inventario: solo dígitos no negativos,
 * máximo 11 enteros y 3 decimales. Acepta formalmente "0" y "0.000" — la
 * validación de "mayor que cero" se implementa en el Bloque B, no aquí.
 * Deliberadamente distinto de STOCK_QUANTITY_PATTERN (src/products/dto/
 * decimal-patterns.ts), que no acota los dígitos enteros y permitiría un
 * valor que desborda Decimal(14,3).
 */
export const INVENTORY_QUANTITY_PATTERN = /^\d{1,11}(\.\d{1,3})?$/;

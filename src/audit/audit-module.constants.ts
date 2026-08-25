/**
 * Conjunto cerrado de valores válidos para el filtro `module` de
 * GET /audit (Fase 10, Bloque E). Es exactamente el conjunto de literales
 * `module: '...'` usados por los emisores reales de AuditService.record()
 * a través de los Bloques A-D de todas las fases (verificado por inspección
 * directa antes de cerrar esta lista): AUTH/USERS (Fase 1), CATEGORIES/UNITS
 * (Fase 2), PRODUCTS (Fase 2, Bloque C)/INVENTORY (Fase 3), CUSTOMERS
 * (Fase 4), QUOTES (Fase 5), SALES (Fase 6, también emite QUOTES para
 * QUOTE_CONVERTED), PAYMENTS (Fase 7), ACCOUNTING (Fase 8), CONFIGURATION
 * (Fase 10, Bloques A y D). No es un enum de Prisma/Postgres: la columna
 * `module` sigue siendo VARCHAR(50); esta lista solo acota el filtro
 * público de lectura, nunca lo que AuditService puede escribir.
 */
export const AUDIT_MODULES = [
  'AUTH',
  'USERS',
  'CATEGORIES',
  'UNITS',
  'PRODUCTS',
  'INVENTORY',
  'CUSTOMERS',
  'QUOTES',
  'SALES',
  'PAYMENTS',
  'ACCOUNTING',
  'CONFIGURATION',
] as const;

export type AuditModuleName = (typeof AUDIT_MODULES)[number];

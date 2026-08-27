/**
 * Token de inyección para ElectronicInvoicingProvider (mismo criterio que
 * IMAGE_STORAGE en Productos): permite sustituir la implementación sin
 * tocar ElectronicDocumentsService. ElectronicInvoicingModule lo resuelve
 * según ELECTRONIC_INVOICING_PROVIDER (env); las pruebas lo sobrescriben
 * con `overrideProvider` en el módulo de testing de Nest.
 */
export const ELECTRONIC_INVOICING_PROVIDER = Symbol(
  'ELECTRONIC_INVOICING_PROVIDER',
);

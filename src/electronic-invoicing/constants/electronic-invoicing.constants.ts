import { Prisma } from '@prisma/client';

/**
 * Último número fiscal representable (Fase 11, Bloque B: FiscalSeries.
 * currentNumber, CHECK fiscal_series_current_number_range, 1..99,999,999).
 * FiscalSeriesService.allocateNext() nunca asigna un número por encima de
 * este límite: la propia condición WHERE del UPDATE lo excluye, nunca se
 * confía únicamente en el CHECK de base de datos como primera defensa.
 */
export const MAX_FISCAL_NUMBER = 99_999_999;

/**
 * Umbral aprobado (Fase 11A/11C, reglas MVP para BOLETA en soles): por
 * debajo o igual a S/700.00 se admite el cliente genérico "Público
 * general"; por encima, se exige un cliente identificado. Solo aplica
 * cuando Sale.currencyCode es exactamente 'PEN' (ver
 * ElectronicDocumentsService.validateCustomerForDocumentType): este bloque
 * no implementa conversión de moneda.
 */
export const BOLETA_GENERIC_CUSTOMER_MAX_TOTAL = new Prisma.Decimal('700.00');

/** RUC peruano: exactamente 11 caracteres numéricos. Sin dígito verificador (MVP). */
export const RUC_PATTERN = /^\d{11}$/;

/** Código de proveedor del Bloque 11C: el único soportado hasta que exista un PSE real. */
export const MOCK_PROVIDER_CODE = 'MOCK';

/**
 * Formato de serie por tipo de documento (Bloque 11B/11D): exactamente 4
 * caracteres alfanuméricos en mayúscula, primer caracter fijo por tipo.
 * Idénticos a los CHECK de base de datos (fiscal_series_series_format_by_type)
 * — la validación del DTO de emisión (Bloque 11D) es una capa de UX que
 * nunca sustituye esa restricción real; el servicio/base de datos siguen
 * siendo la autoridad final.
 */
export const FACTURA_SERIES_PATTERN = /^F[A-Z0-9]{3}$/;
export const BOLETA_SERIES_PATTERN = /^B[A-Z0-9]{3}$/;

/** Relleno de FiscalSeries.number para armar fullNumber (Bloque 11D §14): "F001-00000001". */
export const FISCAL_NUMBER_PAD_LENGTH = 8;

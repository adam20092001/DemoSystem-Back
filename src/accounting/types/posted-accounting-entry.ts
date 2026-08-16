import { AccountingEventType, AccountingSourceType } from '@prisma/client';

/**
 * Resultado interno mínimo de una operación de posteo/reversión de
 * AccountingEngine (Fase 8, Bloque B). No es un contrato HTTP seguro —
 * ninguno existe todavía (Bloque C); solo lo necesario para que el
 * llamador (PaymentEngine/SalesService) y las pruebas verifiquen qué se
 * creó, sin reconstruir un mapeo completo del asiento y sus líneas.
 */
export interface PostedAccountingEntry {
  id: string;
  sourceType: AccountingSourceType;
  sourceId: string;
  eventType: AccountingEventType;
}

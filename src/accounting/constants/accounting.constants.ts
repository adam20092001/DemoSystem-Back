import {
  AccountingSystemKey,
  PaymentMethodAccountingDestination,
} from '@prisma/client';

/**
 * Mapeo fijo de PaymentMethodAccountingDestination -> cuenta de sistema de
 * cobro (plan final aprobado, Fase 8, §5/D6; recableado en Ticket C, Bloque
 * C3): CASH cobra en Caja, BANK cobra en Bancos. El plan de cuentas básico
 * del Documento Maestro (§17) solo define dos cuentas de cobro (Caja,
 * Bancos): no existe una tercera cuenta de tarjeta/billetera digital, así
 * que no se inventa una.
 *
 * Desde el Bloque C3, este mapeo ya NO está indexado por el antiguo enum
 * PaymentMethod (eliminado, 6 valores fijos) sino por
 * PaymentMethodAccountingDestination (2 valores fijos, CASH|BANK) —
 * PaymentEngine resuelve el PaymentMethod dinámico (posiblemente uno de los
 * 9 baseline, o un método personalizado creado por ADMIN) y le pasa a
 * AccountingEngine.postPaymentCollection() únicamente el
 * accountingDestination YA resuelto, nunca el método completo: este mapeo
 * de 2 valores es lo único que necesita para decidir la cuenta, y sigue
 * siendo exhaustivo a nivel de compilador (`Record<PaymentMethodAccounting
 * Destination, AccountingSystemKey>` — agregar un tercer valor al enum sin
 * mapearlo aquí rompe el build, nunca falla en silencio en producción).
 */
export const ACCOUNTING_DESTINATION_TO_SYSTEM_KEY: Record<
  PaymentMethodAccountingDestination,
  AccountingSystemKey
> = {
  [PaymentMethodAccountingDestination.CASH]: AccountingSystemKey.CASH,
  [PaymentMethodAccountingDestination.BANK]: AccountingSystemKey.BANK,
};

/** Igual que Payment.cancellationReason/Sale.cancellationReason (VARCHAR(200), migration.sql de la Fase 8, Bloque A). */
export const ACCOUNTING_DESCRIPTION_MAX_LENGTH = 200;

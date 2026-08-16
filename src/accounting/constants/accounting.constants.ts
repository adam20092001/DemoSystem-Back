import { AccountingSystemKey, PaymentMethod } from '@prisma/client';

/**
 * Mapeo fijo de PaymentMethod -> cuenta de sistema de cobro (plan final
 * aprobado, Fase 8, §5/D6): CASH cobra en Caja; todos los demás métodos
 * (BANK_TRANSFER/BANK_DEPOSIT/CARD/DIGITAL_WALLET/OTHER) cobran en Bancos.
 * El plan de cuentas básico del Documento Maestro (§17) solo define dos
 * cuentas de cobro (Caja, Bancos): no existe una tercera cuenta de tarjeta/
 * billetera digital, así que no se inventa una. `Record<PaymentMethod, ...>`
 * es exhaustivo a nivel de compilador: agregar un método de pago futuro sin
 * mapearlo aquí rompe el build, nunca falla en silencio en producción.
 */
export const PAYMENT_METHOD_TO_ACCOUNTING_SYSTEM_KEY: Record<
  PaymentMethod,
  AccountingSystemKey
> = {
  [PaymentMethod.CASH]: AccountingSystemKey.CASH,
  [PaymentMethod.BANK_TRANSFER]: AccountingSystemKey.BANK,
  [PaymentMethod.BANK_DEPOSIT]: AccountingSystemKey.BANK,
  [PaymentMethod.CARD]: AccountingSystemKey.BANK,
  [PaymentMethod.DIGITAL_WALLET]: AccountingSystemKey.BANK,
  [PaymentMethod.OTHER]: AccountingSystemKey.BANK,
};

/** Igual que Payment.cancellationReason/Sale.cancellationReason (VARCHAR(200), migration.sql de la Fase 8, Bloque A). */
export const ACCOUNTING_DESCRIPTION_MAX_LENGTH = 200;

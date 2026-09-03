import { PaymentMethodAccountingDestination } from '@prisma/client';

/**
 * Forma segura de un método de pago dinámico (Ticket C post-MVP, Bloque C2)
 * expuesta por GET/POST/PATCH /api/v1/payment-methods. `code` es la
 * identidad estable e inmutable (nunca aceptada en un PATCH); `name` es
 * configuración editable. createdAt/updatedAt se exponen por consistencia
 * con el resto de las respuestas CRUD administrables de este dominio
 * (CategoryResponseDto/UnitResponseDto/ProductResponseDto los exponen por
 * igual) — un método de pago es, estructuralmente, la misma clase de
 * entidad "maestro editable por ADMIN" que esas, así que se sigue el mismo
 * contrato en vez de inventar una excepción para esta sola entidad.
 *
 * Nacido en el Bloque C2 como tipo exclusivamente de administración; desde
 * el Bloque C3, PaymentEngine también lo consume internamente (vía
 * PaymentMethodReader, ver payment-method-reader.service.ts) para resolver
 * el método dinámico de cada cobro — nunca se le agregó ningún campo solo
 * para ese consumo interno, el mismo shape sirve para ambos casos de uso.
 */
export interface SafePaymentMethod {
  id: string;
  code: string;
  name: string;
  active: boolean;
  requiresReference: boolean;
  affectsCashDrawer: boolean;
  accountingDestination: PaymentMethodAccountingDestination;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

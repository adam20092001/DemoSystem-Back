import { PaymentMethodAccountingDestination, RoleName } from '@prisma/client';

/**
 * `code` deliberadamente ausente: es inmutable después de creado (Ticket C
 * §14 del audit) — ni siquiera se acepta como campo ignorado, para que no
 * exista ninguna ruta de código que pudiera llegar a escribirlo.
 */
export interface UpdatePaymentMethodInput {
  paymentMethodId: string;
  name?: string;
  active?: boolean;
  requiresReference?: boolean;
  affectsCashDrawer?: boolean;
  accountingDestination?: PaymentMethodAccountingDestination;
  sortOrder?: number;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress?: string | null;
}

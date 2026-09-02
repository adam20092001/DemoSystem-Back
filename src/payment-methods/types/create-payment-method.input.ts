import { PaymentMethodAccountingDestination, RoleName } from '@prisma/client';

export interface CreatePaymentMethodInput {
  code: string;
  name: string;
  requiresReference: boolean;
  affectsCashDrawer: boolean;
  accountingDestination: PaymentMethodAccountingDestination;
  sortOrder?: number;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress?: string | null;
}

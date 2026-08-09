import { Prisma } from '@prisma/client';
import { SafeCustomer } from '../types/safe-customer';

/** Única fuente de verdad para la forma segura de Customer expuesta hacia afuera. */
export const CUSTOMER_SAFE_SELECT = {
  id: true,
  code: true,
  customerType: true,
  customerStage: true,
  documentType: true,
  documentNumber: true,
  name: true,
  tradeName: true,
  contactName: true,
  email: true,
  phone: true,
  address: true,
  internalNotes: true,
  isGeneric: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CustomerSelect;

export type CustomerSafeRow = Prisma.CustomerGetPayload<{
  select: typeof CUSTOMER_SAFE_SELECT;
}>;

export function toSafeCustomer(row: CustomerSafeRow): SafeCustomer {
  return {
    id: row.id,
    code: row.code,
    customerType: row.customerType,
    customerStage: row.customerStage,
    documentType: row.documentType,
    documentNumber: row.documentNumber,
    name: row.name,
    tradeName: row.tradeName,
    contactName: row.contactName,
    email: row.email,
    phone: row.phone,
    address: row.address,
    internalNotes: row.internalNotes,
    isGeneric: row.isGeneric,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

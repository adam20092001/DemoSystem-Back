import { PurchaseInvoiceDocumentType, RoleName } from '@prisma/client';
import { CreatePurchaseInvoiceLineInput } from './create-purchase-invoice.input';

/**
 * Solo aplicable mientras status=DRAFT. `lines`, si se provee, reemplaza
 * el arreglo completo (nunca un parche línea a línea — mismo criterio que
 * ManualJournalDraft, A4.2). supplierId/status/currencyCode/montos de
 * cabecera son inmutables desde aquí.
 */
export interface UpdatePurchaseInvoiceInput {
  purchaseInvoiceId: string;
  documentType?: PurchaseInvoiceDocumentType;
  documentSeries?: string | null;
  documentNumber?: string;
  issueDate?: string;
  registrationDate?: string;
  accountingDate?: string;
  dueDate?: string | null;
  paymentTermsDays?: number | null;
  lines?: CreatePurchaseInvoiceLineInput[];
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}

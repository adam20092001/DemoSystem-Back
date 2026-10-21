/** Input compartido por activate/deactivate. */
export interface SupplierActionInput {
  supplierId: string;
  actorUserId: string;
  ipAddress?: string | null;
}

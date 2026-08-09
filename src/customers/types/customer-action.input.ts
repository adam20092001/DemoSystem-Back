/** Input compartido por activate/deactivate/block/unblock/convertToCustomer. */
export interface CustomerActionInput {
  customerId: string;
  actorUserId: string;
  ipAddress?: string | null;
}

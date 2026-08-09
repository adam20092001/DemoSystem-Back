/** Input compartido por accept/reject. */
export interface QuoteActionInput {
  quoteId: string;
  actorUserId: string;
  ipAddress?: string | null;
}

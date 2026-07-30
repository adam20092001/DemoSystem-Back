export interface CreateUnitInput {
  code: string;
  name: string;
  abbreviation: string;
  allowDecimal?: boolean;
  actorUserId: string;
  ipAddress?: string | null;
}

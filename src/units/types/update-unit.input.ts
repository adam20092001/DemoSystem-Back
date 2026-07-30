export interface UpdateUnitInput {
  unitId: string;
  code?: string;
  name?: string;
  abbreviation?: string;
  allowDecimal?: boolean;
  actorUserId: string;
  ipAddress?: string | null;
}

export interface SafeCountry {
  code: string;
  name: string;
  active: boolean;
  pendingReview: boolean;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

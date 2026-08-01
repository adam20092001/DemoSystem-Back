export interface SetPrimaryProductImageInput {
  productId: string;
  imageId: string;
  actorUserId: string;
  ipAddress?: string | null;
}

export interface RemoveProductImageInput {
  productId: string;
  imageId: string;
  actorUserId: string;
  ipAddress?: string | null;
}

export interface GetProductImageFileInput {
  productId: string;
  imageId: string;
}

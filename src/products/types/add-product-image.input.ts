export interface UploadedImageFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

export interface AddProductImageInput {
  productId: string;
  file: UploadedImageFile;
  sortOrder?: number;
  actorUserId: string;
  ipAddress?: string | null;
}

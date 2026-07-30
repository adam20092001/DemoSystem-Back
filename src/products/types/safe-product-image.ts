/**
 * Forma segura de una imagen de producto. Nunca incluye storagePath, rutas
 * absolutas ni contenido binario: fileUrl solo apunta al endpoint protegido
 * que sirve el archivo bajo autenticación y autorización por rol.
 */
export interface SafeProductImage {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sortOrder: number;
  isPrimary: boolean;
  createdAt: Date;
  fileUrl: string;
}

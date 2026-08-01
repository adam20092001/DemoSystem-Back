import { Readable } from 'node:stream';

export interface SaveImageInput {
  productId: string;
  buffer: Buffer;
  /** Extensión sin punto, derivada del contenido detectado (jpg | png | webp). */
  extension: string;
}

export interface SavedImage {
  /** Ruta relativa a la raíz de almacenamiento. Es lo único que se persiste en BD. */
  storagePath: string;
}

/**
 * Abstracción de almacenamiento de imágenes. ProductImagesService depende
 * únicamente de esta interfaz (vía IMAGE_STORAGE), nunca de la
 * implementación concreta: una futura implementación S3 solo requeriría
 * un nuevo proveedor para el mismo token.
 */
export interface ImageStorage {
  save(input: SaveImageInput): Promise<SavedImage>;
  /** No lanza si el archivo ya no existe; sí propaga errores reales de filesystem. */
  delete(storagePath: string): Promise<void>;
  createReadStream(storagePath: string): Readable;
  exists(storagePath: string): Promise<boolean>;
}

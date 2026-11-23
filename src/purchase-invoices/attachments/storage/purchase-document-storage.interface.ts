import { Readable } from 'node:stream';

export interface SavePurchaseDocumentInput {
  buffer: Buffer;
  /** Extensión sin punto derivada del contenido detectado (pdf | jpg | png). */
  extension: string;
}

export interface SavedPurchaseDocument {
  /**
   * Clave PRIVADA de almacenamiento (relativa a la raíz), generada por el
   * backend, no predecible y nunca derivada del nombre original. Es lo único
   * que se persiste en BD; jamás se expone en la API.
   */
  storageKey: string;
}

/**
 * Abstracción del almacenamiento de documentos de compra. El servicio depende
 * solo de esta interfaz (token PURCHASE_DOCUMENT_STORAGE): una implementación
 * S3/objeto privado solo requiere un nuevo proveedor para el mismo token. Las
 * pruebas usan una implementación en un directorio temporal aislado.
 */
export interface PurchaseDocumentStorage {
  save(input: SavePurchaseDocumentInput): Promise<SavedPurchaseDocument>;
  /** No lanza si el archivo ya no existe; sí propaga errores reales. */
  delete(storageKey: string): Promise<void>;
  createReadStream(storageKey: string): Readable;
  exists(storageKey: string): Promise<boolean>;
}

export const PURCHASE_DOCUMENT_STORAGE = Symbol('PURCHASE_DOCUMENT_STORAGE');

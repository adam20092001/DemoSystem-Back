/** Token de inyección para ImageStorage. Permite sustituir la implementación (p. ej. S3) sin tocar ProductImagesService. */
export const IMAGE_STORAGE = Symbol('IMAGE_STORAGE');

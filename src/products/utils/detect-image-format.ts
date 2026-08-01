export type DetectedImageFormat = 'image/jpeg' | 'image/png' | 'image/webp';

export const ALLOWED_IMAGE_MIME_TYPES: readonly DetectedImageFormat[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

export const EXTENSION_BY_IMAGE_FORMAT: Record<DetectedImageFormat, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasSignature(buffer: Buffer, signature: number[]): boolean {
  if (buffer.length < signature.length) {
    return false;
  }
  return signature.every((byte, index) => buffer[index] === byte);
}

function isWebp(buffer: Buffer): boolean {
  if (buffer.length < 12) {
    return false;
  }
  return (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  );
}

/**
 * Detecta el formato real de una imagen a partir de su firma binaria
 * (magic bytes), nunca a partir de mimetype ni de la extensión declarados
 * por el cliente. Devuelve null si el contenido no coincide con ninguno de
 * los formatos permitidos.
 */
export function detectImageFormat(buffer: Buffer): DetectedImageFormat | null {
  if (hasSignature(buffer, JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }
  if (hasSignature(buffer, PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (isWebp(buffer)) {
    return 'image/webp';
  }
  return null;
}

export function isAllowedImageMimeType(
  value: string,
): value is DetectedImageFormat {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

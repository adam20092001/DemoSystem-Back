/**
 * Validación del CONTENIDO REAL de un documento adjunto (nunca la extensión ni
 * el Content-Type declarado por el cliente). Soporta PDF, JPEG y PNG: firma +
 * estructura mínima verificable (PDF: cabecera, startxref y %%EOF, sin
 * acciones activas; JPEG: marcadores hasta SOF/SOS y EOI final; PNG: IHDR,
 * CRC de cada chunk, IDAT e IEND final). Es una defensa de integridad y de
 * contenido activo; NO sustituye a un antivirus.
 */
export type PurchaseDocumentMime =
  'application/pdf' | 'image/jpeg' | 'image/png';

export const MAX_PURCHASE_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const EXTENSION_BY_PURCHASE_DOCUMENT_MIME: Record<
  PurchaseDocumentMime,
  string
> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

const ACCEPTED_NAME_EXTENSIONS: Record<PurchaseDocumentMime, string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
};

export type PurchaseDocumentRejectionCode =
  | 'ATTACHMENT_EMPTY'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_UNSUPPORTED_TYPE'
  | 'ATTACHMENT_CORRUPT'
  | 'ATTACHMENT_ACTIVE_CONTENT'
  | 'ATTACHMENT_MIME_MISMATCH'
  | 'ATTACHMENT_EXTENSION_MISMATCH';

export interface PurchaseDocumentRejection {
  code: PurchaseDocumentRejectionCode;
  message: string;
}

export type PurchaseDocumentValidation =
  | { ok: true; mime: PurchaseDocumentMime; extension: string }
  | { ok: false; rejection: PurchaseDocumentRejection };

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function reject(
  code: PurchaseDocumentRejectionCode,
  message: string,
): PurchaseDocumentValidation {
  return { ok: false, rejection: { code, message } };
}

function detectMime(buffer: Buffer): PurchaseDocumentMime | null {
  if (
    buffer.length >= 5 &&
    buffer.subarray(0, 5).toString('latin1') === '%PDF-'
  ) {
    return 'application/pdf';
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  return null;
}

function isStructurallyValidPdf(buffer: Buffer): boolean {
  const header = buffer.subarray(0, 12).toString('latin1');
  if (!/^%PDF-(1\.[0-7]|2\.0)/.test(header)) {
    return false;
  }
  const tail = buffer
    .subarray(Math.max(0, buffer.length - 2048))
    .toString('latin1');
  return tail.includes('startxref') && tail.includes('%%EOF');
}

/** Acciones de un PDF que ejecutan código o lanzan programas externos. */
function pdfHasActiveContent(buffer: Buffer): boolean {
  const text = buffer.toString('latin1');
  return /\/(JavaScript|JS|Launch|RichMedia)(?![A-Za-z0-9])/.test(text);
}

function isStructurallyValidJpeg(buffer: Buffer): boolean {
  // Termina en EOI (FFD9), tolerando relleno de ceros finales.
  let end = buffer.length;
  while (end > 0 && buffer[end - 1] === 0x00) {
    end -= 1;
  }
  if (end < 4 || buffer[end - 2] !== 0xff || buffer[end - 1] !== 0xd9) {
    return false;
  }
  let offset = 2;
  let sawFrame = false;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      return false;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9) {
      return false; // EOI antes de datos de imagen
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) {
      return false;
    }
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (length < 8) {
        return false;
      }
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      if (height === 0 || width === 0) {
        return false;
      }
      sawFrame = true;
    }
    if (marker === 0xda) {
      return sawFrame; // comienzan los datos entrópicos; el EOI ya se verificó
    }
    offset += 2 + length;
  }
  return false;
}

function isStructurallyValidPng(buffer: Buffer): boolean {
  let offset = 8;
  let first = true;
  let sawIdat = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const crcStart = dataStart + length;
    if (crcStart + 4 > buffer.length || !/^[A-Za-z]{4}$/.test(type)) {
      return false;
    }
    const expected = buffer.readUInt32BE(crcStart);
    if (crc32(buffer.subarray(offset + 4, crcStart)) !== expected) {
      return false;
    }
    if (first) {
      if (type !== 'IHDR' || length !== 13) {
        return false;
      }
      if (
        buffer.readUInt32BE(dataStart) === 0 ||
        buffer.readUInt32BE(dataStart + 4) === 0
      ) {
        return false;
      }
      first = false;
    }
    if (type === 'IDAT') {
      sawIdat = true;
    }
    offset = crcStart + 4;
    if (type === 'IEND') {
      return length === 0 && sawIdat && offset === buffer.length;
    }
  }
  return false;
}

function extensionOf(fileName: string): string | null {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(fileName.trim());
  return match === null ? null : match[1].toLowerCase();
}

export function validatePurchaseDocument(input: {
  buffer: Buffer;
  declaredMime: string | undefined;
  originalName: string | undefined;
}): PurchaseDocumentValidation {
  const { buffer } = input;
  if (buffer.length === 0) {
    return reject('ATTACHMENT_EMPTY', 'El archivo está vacío');
  }
  if (buffer.length > MAX_PURCHASE_DOCUMENT_BYTES) {
    return reject(
      'ATTACHMENT_TOO_LARGE',
      'El archivo supera el tamaño máximo de 10 MB',
    );
  }
  const mime = detectMime(buffer);
  if (mime === null) {
    return reject(
      'ATTACHMENT_UNSUPPORTED_TYPE',
      'Formato no permitido: solo se aceptan PDF, JPG y PNG',
    );
  }
  if (input.declaredMime !== mime) {
    return reject(
      'ATTACHMENT_MIME_MISMATCH',
      'El contenido del archivo no coincide con el tipo declarado',
    );
  }
  const extension = extensionOf(input.originalName ?? '');
  if (
    extension !== null &&
    !ACCEPTED_NAME_EXTENSIONS[mime].includes(extension)
  ) {
    return reject(
      'ATTACHMENT_EXTENSION_MISMATCH',
      'La extensión del archivo no coincide con su contenido real',
    );
  }
  const valid =
    mime === 'application/pdf'
      ? isStructurallyValidPdf(buffer)
      : mime === 'image/jpeg'
        ? isStructurallyValidJpeg(buffer)
        : isStructurallyValidPng(buffer);
  if (!valid) {
    return reject(
      'ATTACHMENT_CORRUPT',
      'El archivo está dañado o tiene una estructura inválida',
    );
  }
  if (mime === 'application/pdf' && pdfHasActiveContent(buffer)) {
    return reject(
      'ATTACHMENT_ACTIVE_CONTENT',
      'El PDF contiene contenido activo (JavaScript o acciones de lanzamiento) y no se acepta',
    );
  }
  return {
    ok: true,
    mime,
    extension: EXTENSION_BY_PURCHASE_DOCUMENT_MIME[mime],
  };
}

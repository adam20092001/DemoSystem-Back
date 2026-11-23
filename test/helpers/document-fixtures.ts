import { deflateSync } from 'node:zlib';

/**
 * Archivos binarios mínimos pero ESTRUCTURALMENTE válidos (PDF, JPEG, PNG) para
 * pruebas unitarias y E2E de documentos adjuntos. Nunca contienen contenido real.
 */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** `seed` cambia el color del píxel para obtener archivos distintos (otro sha256). */
export function makePng(seed = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, seed % 256, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function makeJpeg(seed = 0): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x4a,
    0x46,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    0x00,
    0x01,
    0x00,
    0x01,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xda,
    0x00,
    0x08,
    0x01,
    0x01,
    0x00,
    0x00,
    0x3f,
    0x00,
    seed % 256,
    0xff,
    0xd9,
  ]);
}

export function makePdf(extra = '', padding = 0): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog ${extra}>>\nendobj\n${'%'.repeat(padding)}\ntrailer\n<< /Root 1 0 R >>\nstartxref\n9\n%%EOF\n`,
    'latin1',
  );
}

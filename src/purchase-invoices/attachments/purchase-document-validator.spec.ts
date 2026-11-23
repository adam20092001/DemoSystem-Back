import {
  makeJpeg,
  makePdf,
  makePng,
} from '../../../test/helpers/document-fixtures';
import {
  MAX_PURCHASE_DOCUMENT_BYTES,
  validatePurchaseDocument,
} from './purchase-document-validator';

function reason(
  buffer: Buffer,
  declaredMime: string,
  originalName = 'x',
): string | null {
  const r = validatePurchaseDocument({ buffer, declaredMime, originalName });
  return r.ok ? null : r.rejection.code;
}

describe('validatePurchaseDocument', () => {
  it('acepta PDF, JPEG y PNG estructuralmente válidos', () => {
    expect(
      validatePurchaseDocument({
        buffer: makePdf(),
        declaredMime: 'application/pdf',
        originalName: 'f.PDF',
      }),
    ).toMatchObject({ ok: true, mime: 'application/pdf', extension: 'pdf' });
    expect(
      validatePurchaseDocument({
        buffer: makeJpeg(),
        declaredMime: 'image/jpeg',
        originalName: 'a.jpeg',
      }),
    ).toMatchObject({ ok: true, extension: 'jpg' });
    expect(
      validatePurchaseDocument({
        buffer: makePng(),
        declaredMime: 'image/png',
        originalName: 'a.png',
      }),
    ).toMatchObject({ ok: true, extension: 'png' });
  });

  it('rechaza vacío, grande, tipo desconocido y MIME declarado falso', () => {
    expect(reason(Buffer.alloc(0), 'application/pdf')).toBe('ATTACHMENT_EMPTY');
    expect(
      reason(Buffer.alloc(MAX_PURCHASE_DOCUMENT_BYTES + 1), 'application/pdf'),
    ).toBe('ATTACHMENT_TOO_LARGE');
    expect(reason(Buffer.from('MZ-ejecutable'), 'application/pdf')).toBe(
      'ATTACHMENT_UNSUPPORTED_TYPE',
    );
    expect(reason(makePng(), 'application/pdf')).toBe(
      'ATTACHMENT_MIME_MISMATCH',
    );
  });

  it('rechaza extensión falsa (contenido PNG con nombre .pdf)', () => {
    expect(reason(makePng(), 'image/png', 'factura.pdf')).toBe(
      'ATTACHMENT_EXTENSION_MISMATCH',
    );
  });

  it('rechaza archivos truncados o corruptos', () => {
    expect(reason(makePdf().subarray(0, 30), 'application/pdf')).toBe(
      'ATTACHMENT_CORRUPT',
    );
    expect(reason(makeJpeg().subarray(0, 20), 'image/jpeg')).toBe(
      'ATTACHMENT_CORRUPT',
    );
    const png = makePng();
    expect(reason(png.subarray(0, png.length - 8), 'image/png')).toBe(
      'ATTACHMENT_CORRUPT',
    );
    const flipped = Buffer.from(png);
    flipped[20] ^= 0xff; // rompe el CRC de IHDR
    expect(reason(flipped, 'image/png')).toBe('ATTACHMENT_CORRUPT');
  });

  it('rechaza PDF con JavaScript o acciones de lanzamiento', () => {
    expect(
      reason(makePdf('/JavaScript (app.alert(1)) '), 'application/pdf'),
    ).toBe('ATTACHMENT_ACTIVE_CONTENT');
    expect(
      reason(makePdf('/OpenAction << /S /Launch >> '), 'application/pdf'),
    ).toBe('ATTACHMENT_ACTIVE_CONTENT');
  });
});

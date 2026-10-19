import { Prisma } from '@prisma/client';
import { deriveStockStatus } from './stock-status';

function D(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('deriveStockStatus', () => {
  it('stock por encima del umbral: NORMAL', () => {
    expect(deriveStockStatus(D('4'), D('3'))).toBe('NORMAL');
  });

  it('stock exactamente en el umbral: LOW_STOCK', () => {
    expect(deriveStockStatus(D('3'), D('3'))).toBe('LOW_STOCK');
  });

  it('stock por debajo del umbral (pero > 0): LOW_STOCK', () => {
    expect(deriveStockStatus(D('1'), D('3'))).toBe('LOW_STOCK');
  });

  it('stock en cero: OUT_OF_STOCK, sin importar el umbral configurado', () => {
    expect(deriveStockStatus(D('0'), D('3'))).toBe('OUT_OF_STOCK');
    expect(deriveStockStatus(D('0'), D('0'))).toBe('OUT_OF_STOCK');
    expect(deriveStockStatus(D('0'), D('100'))).toBe('OUT_OF_STOCK');
  });

  it('umbral configurado en 0: solo OUT_OF_STOCK en cero; cualquier stock > 0 es NORMAL (nunca LOW_STOCK)', () => {
    expect(deriveStockStatus(D('1'), D('0'))).toBe('NORMAL');
    expect(deriveStockStatus(D('0.001'), D('0'))).toBe('NORMAL');
  });

  it('frontera exacta un paso por encima del umbral: NORMAL', () => {
    expect(deriveStockStatus(D('3.001'), D('3'))).toBe('NORMAL');
  });

  it('umbral configurado por producto distinto de 3 (histórico o personalizado): la clasificación sigue ese umbral, no un valor fijo', () => {
    expect(deriveStockStatus(D('10'), D('10'))).toBe('LOW_STOCK');
    expect(deriveStockStatus(D('11'), D('10'))).toBe('NORMAL');
    expect(deriveStockStatus(D('9'), D('10'))).toBe('LOW_STOCK');
  });

  it('cantidades fraccionarias (Decimal(14,3)): respeta la precisión sin redondear', () => {
    expect(deriveStockStatus(D('0.500'), D('3.000'))).toBe('LOW_STOCK');
    expect(deriveStockStatus(D('3.001'), D('3.000'))).toBe('NORMAL');
  });
});

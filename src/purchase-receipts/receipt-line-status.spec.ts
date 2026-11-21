import { Prisma } from '@prisma/client';
import {
  computeReceiptLineQuantities,
  computeReceiptLineStatus,
} from './receipt-line-status';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('computeReceiptLineStatus', () => {
  it('receivedQuantity=0 -> PENDING', () => {
    expect(computeReceiptLineStatus(d('0'), d('10'))).toBe('PENDING');
  });

  it('0 < receivedQuantity < invoicedQuantity -> PARTIAL', () => {
    expect(computeReceiptLineStatus(d('4'), d('10'))).toBe('PARTIAL');
  });

  it('receivedQuantity === invoicedQuantity -> COMPLETE', () => {
    expect(computeReceiptLineStatus(d('10'), d('10'))).toBe('COMPLETE');
  });

  it('receivedQuantity > invoicedQuantity (defensa en profundidad) -> COMPLETE', () => {
    expect(computeReceiptLineStatus(d('11'), d('10'))).toBe('COMPLETE');
  });

  it('4 + 6 de 10: PARTIAL tras la primera, COMPLETE tras la segunda', () => {
    expect(computeReceiptLineStatus(d('4'), d('10'))).toBe('PARTIAL');
    expect(computeReceiptLineStatus(d('10'), d('10'))).toBe('COMPLETE');
  });
});

describe('computeReceiptLineQuantities (R1)', () => {
  it('línea sin recepciones: pendiente = facturado, PENDING', () => {
    expect(computeReceiptLineQuantities(d('0'), d('10'))).toEqual({
      invoicedQuantity: '10.000',
      receivedQuantity: '0.000',
      pendingQuantity: '10.000',
      status: 'PENDING',
    });
  });

  it('recepción parcial: PARTIAL con pendiente correcto', () => {
    expect(computeReceiptLineQuantities(d('4'), d('10'))).toEqual({
      invoicedQuantity: '10.000',
      receivedQuantity: '4.000',
      pendingQuantity: '6.000',
      status: 'PARTIAL',
    });
  });

  it('recibido completo: COMPLETE con pendiente 0', () => {
    const result = computeReceiptLineQuantities(d('10'), d('10'));
    expect(result.pendingQuantity).toBe('0.000');
    expect(result.status).toBe('COMPLETE');
  });

  it('recibido de más (defensa en profundidad): el pendiente nunca es negativo', () => {
    expect(computeReceiptLineQuantities(d('11'), d('10')).pendingQuantity).toBe(
      '0.000',
    );
  });

  it('preserva 3 decimales exactos (sin float)', () => {
    expect(
      computeReceiptLineQuantities(d('0.1'), d('0.3')).pendingQuantity,
    ).toBe('0.200');
  });
});

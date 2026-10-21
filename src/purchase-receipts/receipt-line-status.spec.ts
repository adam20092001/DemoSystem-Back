import { Prisma } from '@prisma/client';
import { computeReceiptLineStatus } from './receipt-line-status';

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

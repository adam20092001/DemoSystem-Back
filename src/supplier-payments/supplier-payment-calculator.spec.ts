import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertReferenceRequiredForSupplierPaymentMethod,
  assertValidSupplierPaymentAmountShape,
  computeAccountsPayableStatus,
  groupLiabilityAmountsByAccount,
  normalizeSupplierPaymentMethodCode,
  normalizeSupplierPaymentReference,
  parseSupplierPaymentAmount,
} from './supplier-payment-calculator';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('parseSupplierPaymentAmount', () => {
  it('decimal válido con 2 decimales: parsea correctamente', () => {
    expect(parseSupplierPaymentAmount('150.00').toFixed(2)).toBe('150.00');
  });

  it('notación inválida (coma, negativo, científica): BadRequestException', () => {
    expect(() => parseSupplierPaymentAmount('150,00')).toThrow(
      BadRequestException,
    );
    expect(() => parseSupplierPaymentAmount('-10.00')).toThrow(
      BadRequestException,
    );
    expect(() => parseSupplierPaymentAmount('1e10')).toThrow(
      BadRequestException,
    );
  });

  it('cero: BadRequestException (debe ser mayor que cero)', () => {
    expect(() => parseSupplierPaymentAmount('0.00')).toThrow(
      BadRequestException,
    );
  });

  it('más de 2 decimales: BadRequestException', () => {
    expect(() => parseSupplierPaymentAmount('10.001')).toThrow(
      BadRequestException,
    );
  });
});

describe('assertValidSupplierPaymentAmountShape', () => {
  it('monto válido: no lanza', () => {
    expect(() =>
      assertValidSupplierPaymentAmountShape(d('10.00')),
    ).not.toThrow();
  });

  it('excede el máximo representable: BadRequestException', () => {
    expect(() =>
      assertValidSupplierPaymentAmountShape(d('9999999999999.99')),
    ).toThrow(BadRequestException);
  });
});

describe('computeAccountsPayableStatus', () => {
  it('paidAmount <= 0 -> UNPAID', () => {
    expect(computeAccountsPayableStatus(d('0'), d('100.00'))).toBe('UNPAID');
  });

  it('paidAmount >= totalAmount -> PAID', () => {
    expect(computeAccountsPayableStatus(d('100.00'), d('100.00'))).toBe('PAID');
    expect(computeAccountsPayableStatus(d('150.00'), d('100.00'))).toBe('PAID');
  });

  it('0 < paidAmount < totalAmount -> PARTIALLY_PAID', () => {
    expect(computeAccountsPayableStatus(d('40.00'), d('100.00'))).toBe(
      'PARTIALLY_PAID',
    );
  });
});

describe('groupLiabilityAmountsByAccount', () => {
  it('cuentas distintas: una línea por cuenta, sin mezclar montos', () => {
    const result = groupLiabilityAmountsByAccount([
      { accountId: 'acc-1', amount: d('40.00') },
      { accountId: 'acc-2', amount: d('60.00') },
    ]);
    const byAccount = new Map(result.map((r) => [r.accountId, r.amount]));
    expect(byAccount.get('acc-1')?.toFixed(2)).toBe('40.00');
    expect(byAccount.get('acc-2')?.toFixed(2)).toBe('60.00');
  });

  it('misma cuenta en varias facturas: se suman en una sola línea', () => {
    const result = groupLiabilityAmountsByAccount([
      { accountId: 'acc-1', amount: d('40.00') },
      { accountId: 'acc-1', amount: d('60.00') },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].amount.toFixed(2)).toBe('100.00');
  });
});

describe('normalizeSupplierPaymentMethodCode', () => {
  it('normaliza a mayúsculas y recorta espacios', () => {
    expect(normalizeSupplierPaymentMethodCode('  cash  ')).toBe('CASH');
  });

  it('formato inválido: BadRequestException', () => {
    expect(() => normalizeSupplierPaymentMethodCode('1CASH')).toThrow(
      BadRequestException,
    );
  });
});

describe('assertReferenceRequiredForSupplierPaymentMethod', () => {
  it('requiresReference=true sin referencia: BadRequestException', () => {
    expect(() =>
      assertReferenceRequiredForSupplierPaymentMethod(true, null),
    ).toThrow(BadRequestException);
  });

  it('requiresReference=true con referencia: no lanza', () => {
    expect(() =>
      assertReferenceRequiredForSupplierPaymentMethod(true, 'OP-001'),
    ).not.toThrow();
  });

  it('requiresReference=false sin referencia: no lanza', () => {
    expect(() =>
      assertReferenceRequiredForSupplierPaymentMethod(false, null),
    ).not.toThrow();
  });
});

describe('normalizeSupplierPaymentReference', () => {
  it('undefined/null -> null', () => {
    expect(normalizeSupplierPaymentReference(undefined)).toBeNull();
    expect(normalizeSupplierPaymentReference(null)).toBeNull();
  });

  it('cadena vacía tras recortar -> null', () => {
    expect(normalizeSupplierPaymentReference('   ')).toBeNull();
  });

  it('texto válido: recorta espacios', () => {
    expect(normalizeSupplierPaymentReference('  OP-001  ')).toBe('OP-001');
  });

  it('excede la longitud máxima: BadRequestException', () => {
    expect(() => normalizeSupplierPaymentReference('x'.repeat(101))).toThrow(
      BadRequestException,
    );
  });
});

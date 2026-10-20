import { AccountType } from '@prisma/client';
import {
  ROOT_ACCOUNT_LEVEL,
  accountNormalBalance,
  computeChildLevel,
} from './account-hierarchy.utils';

describe('accountNormalBalance', () => {
  it.each([
    [AccountType.ASSET, 'DEBIT'],
    [AccountType.EXPENSE, 'DEBIT'],
    [AccountType.COST, 'DEBIT'],
    [AccountType.CONTRA_REVENUE, 'DEBIT'],
    [AccountType.LIABILITY, 'CREDIT'],
    [AccountType.EQUITY, 'CREDIT'],
    [AccountType.REVENUE, 'CREDIT'],
  ])('%s -> %s', (type, expected) => {
    expect(accountNormalBalance(type)).toBe(expected);
  });

  it('coincide con el lado que accounting-calculator.ts ya usa para DISCOUNTS (CONTRA_REVENUE)', () => {
    // buildSaleRecognitionLines() debita DISCOUNTS: confirma que la
    // derivación de naturaleza normal no contradice el comportamiento ya
    // posteado por AccountingEngine.
    expect(accountNormalBalance(AccountType.CONTRA_REVENUE)).toBe('DEBIT');
  });

  it('coincide con el lado que accounting-calculator.ts ya usa para SALES_REVENUE (REVENUE) y VAT_PAYABLE (LIABILITY)', () => {
    expect(accountNormalBalance(AccountType.REVENUE)).toBe('CREDIT');
    expect(accountNormalBalance(AccountType.LIABILITY)).toBe('CREDIT');
  });
});

describe('computeChildLevel', () => {
  it('raíz (level 1) -> hijo level 2', () => {
    expect(computeChildLevel(ROOT_ACCOUNT_LEVEL)).toBe(2);
  });

  it('nivel arbitrario N -> N + 1', () => {
    expect(computeChildLevel(5)).toBe(6);
  });
});

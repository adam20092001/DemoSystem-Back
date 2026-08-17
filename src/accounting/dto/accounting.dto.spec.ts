import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { AccountingEventType, AccountingSourceType } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createValidationPipe } from '../../common/pipes/validation.pipe';
import { ListAccountingEntriesQueryDto } from './list-accounting-entries-query.dto';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

async function expectRejectedQueryProperty(
  Dto: new () => object,
  payload: Record<string, unknown>,
  offendingProperty: string,
): Promise<void> {
  const pipe = createValidationPipe();
  expect.assertions(2);
  try {
    await pipe.transform(payload, { type: 'query', metatype: Dto });
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as {
      message: string[];
    };
    expect(body.message.join(' ')).toMatch(new RegExp(offendingProperty));
  }
}

describe('ListAccountingEntriesQueryDto', () => {
  it('query vacía es válida (todos los campos opcionales)', async () => {
    const instance = plainToInstance(ListAccountingEntriesQueryDto, {});
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('page/limit válidos', async () => {
    const instance = plainToInstance(ListAccountingEntriesQueryDto, {
      page: '2',
      limit: '50',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('page < 1 reporta error', async () => {
    const instance = plainToInstance(ListAccountingEntriesQueryDto, {
      page: '0',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'page')).toBe(true);
  });

  it('limit > 100 reporta error', async () => {
    const instance = plainToInstance(ListAccountingEntriesQueryDto, {
      limit: '500',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it('sourceType/eventType válidos', async () => {
    const instance = plainToInstance(ListAccountingEntriesQueryDto, {
      sourceType: AccountingSourceType.SALE,
      eventType: AccountingEventType.ORIGINAL,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('sourceType inválido reporta error', async () => {
    const instance = plainToInstance(ListAccountingEntriesQueryDto, {
      sourceType: 'NOT_A_SOURCE_TYPE',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'sourceType')).toBe(true);
  });

  it('eventType inválido reporta error', async () => {
    const instance = plainToInstance(ListAccountingEntriesQueryDto, {
      eventType: 'NOT_AN_EVENT_TYPE',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'eventType')).toBe(true);
  });

  it('sourceId UUID válido: sin errores', async () => {
    const instance = plainToInstance(ListAccountingEntriesQueryDto, {
      sourceId: VALID_UUID,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('sourceId inválido reporta error', async () => {
    const instance = plainToInstance(ListAccountingEntriesQueryDto, {
      sourceId: 'not-a-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'sourceId')).toBe(true);
  });

  it('postedFrom/postedTo con formato YYYY-MM-DD válido: sin errores', async () => {
    const instance = plainToInstance(ListAccountingEntriesQueryDto, {
      postedFrom: '2026-03-01',
      postedTo: '2026-03-31',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it.each([
    ['30 de febrero', '2026-02-30'],
    ['con timestamp', '2026-08-10T10:00:00Z'],
    ['separador incorrecto', '2026/08/09'],
  ])('postedFrom inválida (%s) reporta error', async (_label, postedFrom) => {
    const instance = plainToInstance(ListAccountingEntriesQueryDto, {
      postedFrom,
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'postedFrom')).toBe(true);
  });

  describe('whitelist — sin search/sort/orderBy/direction/accountId/amount/balance/status', () => {
    it.each([
      'search',
      'sort',
      'orderBy',
      'direction',
      'accountId',
      'amount',
      'balance',
      'status',
    ])('"%s" -> 400 por whitelist', async (field) => {
      await expectRejectedQueryProperty(
        ListAccountingEntriesQueryDto,
        { [field]: 'x' },
        field,
      );
    });
  });
});

import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { CustomerType, PaymentStatus, QuoteStatus } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createValidationPipe } from '../../common/pipes/validation.pipe';
import { PaymentsByMethodQueryDto } from './payments-by-method-query.dto';
import { QuotesByStatusQueryDto } from './quotes-by-status-query.dto';
import { SalesByCustomerQueryDto } from './sales-by-customer-query.dto';
import { SalesByProductQueryDto } from './sales-by-product-query.dto';
import { SalesBySellerQueryDto } from './sales-by-seller-query.dto';

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

/**
 * Casos comunes de page/limit/from/to heredados de ReportDateRangeQueryDto,
 * ejecutados una vez por cada uno de los 5 DTOs concretos (nunca se testea
 * la base sola: no se expone directamente en ningún endpoint).
 */
function describeCommonDateRangeCases(
  label: string,
  Dto: new () => object,
): void {
  describe(`${label} — page/limit/from/to comunes`, () => {
    it('query vacía es válida (todos los campos opcionales)', async () => {
      const instance = plainToInstance(Dto, {});
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    });

    it('page/limit válidos', async () => {
      const instance = plainToInstance(Dto, { page: '2', limit: '50' });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    });

    it('page < 1 reporta error', async () => {
      const instance = plainToInstance(Dto, { page: '0' });
      const errors = await validate(instance);
      expect(errors.some((e) => e.property === 'page')).toBe(true);
    });

    it('limit > 100 reporta error', async () => {
      const instance = plainToInstance(Dto, { limit: '500' });
      const errors = await validate(instance);
      expect(errors.some((e) => e.property === 'limit')).toBe(true);
    });

    it('from/to con formato YYYY-MM-DD válido: sin errores', async () => {
      const instance = plainToInstance(Dto, {
        from: '2026-08-01',
        to: '2026-08-31',
      });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    });

    it('from solo (sin to) es válido', async () => {
      const instance = plainToInstance(Dto, { from: '2026-08-01' });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    });

    it('to solo (sin from) es válido', async () => {
      const instance = plainToInstance(Dto, { to: '2026-08-31' });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    });

    it.each([
      ['30 de febrero', '2026-02-30'],
      ['con timestamp', '2026-08-10T10:00:00Z'],
      ['separador incorrecto', '2026/08/09'],
    ])('from inválida (%s) reporta error', async (_label, from) => {
      const instance = plainToInstance(Dto, { from });
      const errors = await validate(instance);
      expect(errors.some((e) => e.property === 'from')).toBe(true);
    });

    it.each([
      ['30 de febrero', '2026-02-30'],
      ['con timestamp', '2026-08-10T10:00:00Z'],
      ['separador incorrecto', '2026/08/09'],
    ])('to inválida (%s) reporta error', async (_label, to) => {
      const instance = plainToInstance(Dto, { to });
      const errors = await validate(instance);
      expect(errors.some((e) => e.property === 'to')).toBe(true);
    });

    it('campo desconocido -> 400 por whitelist', async () => {
      await expectRejectedQueryProperty(Dto, { notAField: 'x' }, 'notAField');
    });
  });
}

describe('SalesByProductQueryDto (R2)', () => {
  describeCommonDateRangeCases(
    'SalesByProductQueryDto',
    SalesByProductQueryDto,
  );

  it('categoryId/productId UUID válidos: sin errores', async () => {
    const instance = plainToInstance(SalesByProductQueryDto, {
      categoryId: VALID_UUID,
      productId: VALID_UUID,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('categoryId inválido reporta error', async () => {
    const instance = plainToInstance(SalesByProductQueryDto, {
      categoryId: 'not-a-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'categoryId')).toBe(true);
  });

  it('productId inválido reporta error', async () => {
    const instance = plainToInstance(SalesByProductQueryDto, {
      productId: 'not-a-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'productId')).toBe(true);
  });
});

describe('SalesByCustomerQueryDto (R3)', () => {
  describeCommonDateRangeCases(
    'SalesByCustomerQueryDto',
    SalesByCustomerQueryDto,
  );

  it('customerId/customerType válidos: sin errores', async () => {
    const instance = plainToInstance(SalesByCustomerQueryDto, {
      customerId: VALID_UUID,
      customerType: CustomerType.PERSON,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('customerId inválido reporta error', async () => {
    const instance = plainToInstance(SalesByCustomerQueryDto, {
      customerId: 'not-a-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'customerId')).toBe(true);
  });

  it('customerType inválido reporta error', async () => {
    const instance = plainToInstance(SalesByCustomerQueryDto, {
      customerType: 'NOT_A_CUSTOMER_TYPE',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'customerType')).toBe(true);
  });

  it('sin parámetro status (no existe en este DTO)', async () => {
    await expectRejectedQueryProperty(
      SalesByCustomerQueryDto,
      { status: 'ACTIVE' },
      'status',
    );
  });
});

describe('SalesBySellerQueryDto (R4)', () => {
  describeCommonDateRangeCases('SalesBySellerQueryDto', SalesBySellerQueryDto);

  it('sellerId UUID válido: sin errores', async () => {
    const instance = plainToInstance(SalesBySellerQueryDto, {
      sellerId: VALID_UUID,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('sellerId inválido reporta error', async () => {
    const instance = plainToInstance(SalesBySellerQueryDto, {
      sellerId: 'not-a-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'sellerId')).toBe(true);
  });
});

describe('QuotesByStatusQueryDto (R8)', () => {
  describeCommonDateRangeCases(
    'QuotesByStatusQueryDto',
    QuotesByStatusQueryDto,
  );

  it('status/sellerId/customerId válidos: sin errores', async () => {
    const instance = plainToInstance(QuotesByStatusQueryDto, {
      status: QuoteStatus.CONVERTED,
      sellerId: VALID_UUID,
      customerId: VALID_UUID,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('status inválido reporta error', async () => {
    const instance = plainToInstance(QuotesByStatusQueryDto, {
      status: 'NOT_A_STATUS',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'status')).toBe(true);
  });

  it('sellerId inválido reporta error', async () => {
    const instance = plainToInstance(QuotesByStatusQueryDto, {
      sellerId: 'not-a-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'sellerId')).toBe(true);
  });

  it('customerId inválido reporta error', async () => {
    const instance = plainToInstance(QuotesByStatusQueryDto, {
      customerId: 'not-a-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'customerId')).toBe(true);
  });
});

describe('PaymentsByMethodQueryDto (R9)', () => {
  describeCommonDateRangeCases(
    'PaymentsByMethodQueryDto',
    PaymentsByMethodQueryDto,
  );

  it('method/status/createdByUserId válidos: sin errores', async () => {
    const instance = plainToInstance(PaymentsByMethodQueryDto, {
      method: 'CASH',
      status: PaymentStatus.ACTIVE,
      createdByUserId: VALID_UUID,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('method con formato de código dinámico arbitrario: sin errores (filtra el snapshot histórico, no valida existencia aquí)', async () => {
    const instance = plainToInstance(PaymentsByMethodQueryDto, {
      method: 'NOT_A_METHOD',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('method de más de 30 caracteres reporta error', async () => {
    const instance = plainToInstance(PaymentsByMethodQueryDto, {
      method: 'A'.repeat(31),
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'method')).toBe(true);
  });

  it('status inválido reporta error', async () => {
    const instance = plainToInstance(PaymentsByMethodQueryDto, {
      status: 'NOT_A_STATUS',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'status')).toBe(true);
  });

  it('createdByUserId inválido reporta error', async () => {
    const instance = plainToInstance(PaymentsByMethodQueryDto, {
      createdByUserId: 'not-a-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'createdByUserId')).toBe(true);
  });
});

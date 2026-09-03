import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import {
  SaleDeliveryStatus,
  SalePaymentStatus,
  SaleStatus,
} from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createValidationPipe } from '../../common/pipes/validation.pipe';
import { CancelSaleDto } from './cancel-sale.dto';
import { ConvertQuoteToSaleDto } from './convert-quote-to-sale.dto';
import { CreateSaleDto } from './create-sale.dto';
import { ListSalesQueryDto } from './list-sales-query.dto';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const VALID_UUID_2 = '22222222-2222-4222-8222-222222222222';

async function expectRejectedProperty(
  Dto: new () => object,
  payload: Record<string, unknown>,
  offendingProperty: string,
): Promise<void> {
  const pipe = createValidationPipe();
  expect.assertions(2);
  try {
    await pipe.transform(payload, { type: 'body', metatype: Dto });
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as {
      message: string[];
    };
    expect(body.message.join(' ')).toMatch(new RegExp(offendingProperty));
  }
}

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

describe('CreateSaleDto', () => {
  const baseValid = {
    customerId: VALID_UUID,
    items: [{ productId: VALID_UUID_2, quantity: '2.500' }],
  };

  it('venta válida con un ítem no reporta errores', async () => {
    const instance = plainToInstance(CreateSaleDto, baseValid);
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('múltiples ítems válidos', async () => {
    const instance = plainToInstance(CreateSaleDto, {
      ...baseValid,
      items: [
        { productId: VALID_UUID_2, quantity: '1' },
        { productId: VALID_UUID, quantity: '2.250' },
      ],
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('cantidad decimal válida (hasta 3 posiciones)', async () => {
    const instance = plainToInstance(CreateSaleDto, {
      ...baseValid,
      items: [{ productId: VALID_UUID_2, quantity: '0.125' }],
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('discountAmount ausente es válido', async () => {
    const instance = plainToInstance(CreateSaleDto, baseValid);
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('discountAmount presente y válido', async () => {
    const instance = plainToInstance(CreateSaleDto, {
      ...baseValid,
      discountAmount: '15.00',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('customerId inválido reporta error', async () => {
    const instance = plainToInstance(CreateSaleDto, {
      ...baseValid,
      customerId: 'not-a-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'customerId')).toBe(true);
  });

  it('items ausente reporta error', async () => {
    const instance = plainToInstance(CreateSaleDto, {
      customerId: VALID_UUID,
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'items')).toBe(true);
  });

  it('items vacío reporta error (ArrayMinSize)', async () => {
    const instance = plainToInstance(CreateSaleDto, {
      ...baseValid,
      items: [],
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'items')).toBe(true);
  });

  describe('cantidad malformada del ítem', () => {
    it.each([
      ['negativa', '-1'],
      ['notación científica', '1e3'],
      ['notación científica mayúscula', '1E3'],
      ['coma decimal', '1,5'],
      ['más de 3 decimales', '1.2345'],
      ['no numérica', 'abc'],
    ])('%s -> error', async (_label, quantity) => {
      const instance = plainToInstance(CreateSaleDto, {
        ...baseValid,
        items: [{ productId: VALID_UUID_2, quantity }],
      });
      const errors = await validate(instance, { whitelist: true });
      const itemErrors = errors.find((e) => e.property === 'items');
      expect(itemErrors).toBeDefined();
    });
  });

  describe('discountAmount malformado', () => {
    it.each([
      ['negativo', '-5.00'],
      ['notación científica', '1e2'],
      ['coma decimal', '10,00'],
      ['más de 2 decimales', '10.999'],
    ])('%s -> error', async (_label, discountAmount) => {
      const instance = plainToInstance(CreateSaleDto, {
        ...baseValid,
        discountAmount,
      });
      const errors = await validate(instance);
      expect(errors.some((e) => e.property === 'discountAmount')).toBe(true);
    });
  });

  describe('whitelist — campos prohibidos en la cabecera', () => {
    it.each([
      'number',
      'status',
      'paymentStatus',
      'deliveryStatus',
      'sellerId',
      'confirmedAt',
      'subtotal',
      'taxAmount',
      'total',
      'paidAmount',
      'balanceDue',
      'customerName',
      'customerType',
      'notes',
      'payment',
      'paymentMethod',
    ])('"%s" -> 400 por whitelist', async (field) => {
      await expectRejectedProperty(
        CreateSaleDto,
        { ...baseValid, [field]: 'x' },
        field,
      );
    });
  });

  describe('whitelist — campos prohibidos en el ítem anidado', () => {
    it.each([
      'unitPrice',
      'lineTotal',
      'productName',
      'productSku',
      'stockInfo',
    ])('"%s" -> 400 por whitelist', async (field) => {
      await expectRejectedProperty(
        CreateSaleDto,
        {
          ...baseValid,
          items: [{ productId: VALID_UUID_2, quantity: '1', [field]: 'x' }],
        },
        field,
      );
    });
  });

  describe('pago inicial anidado (Fase 7, Bloque C)', () => {
    it('sin payment: válido (comportamiento de la Fase 6 preservado)', async () => {
      const instance = plainToInstance(CreateSaleDto, baseValid);
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    });

    it('payment válido (CASH sin referencia): no reporta errores', async () => {
      const instance = plainToInstance(CreateSaleDto, {
        ...baseValid,
        payment: { method: 'CASH', amount: '10.00' },
      });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    });

    it('payment válido con referencia: no reporta errores', async () => {
      const instance = plainToInstance(CreateSaleDto, {
        ...baseValid,
        payment: {
          method: 'BANK_TRANSFER',
          amount: '10.00',
          reference: 'OP-000123',
        },
      });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    });

    it('payment.method con formato de código dinámico arbitrario: sin error anidado (existencia/actividad se validan en el dominio, Ticket C, Bloque C3)', async () => {
      const instance = plainToInstance(CreateSaleDto, {
        ...baseValid,
        payment: { method: 'NOT_A_METHOD', amount: '10.00' },
      });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    });

    it('payment.method de más de 30 caracteres reporta error anidado', async () => {
      const instance = plainToInstance(CreateSaleDto, {
        ...baseValid,
        payment: { method: 'A'.repeat(31), amount: '10.00' },
      });
      const errors = await validate(instance);
      expect(errors.some((e) => e.property === 'payment')).toBe(true);
    });

    it.each([
      ['negativo', '-10.00'],
      ['notación científica', '1e2'],
      ['coma decimal', '10,00'],
      ['más de 2 decimales', '10.999'],
    ])(
      'payment.amount malformado (%s) reporta error anidado',
      async (_label, amount) => {
        const instance = plainToInstance(CreateSaleDto, {
          ...baseValid,
          payment: { method: 'CASH', amount },
        });
        const errors = await validate(instance);
        expect(errors.some((e) => e.property === 'payment')).toBe(true);
      },
    );

    it('campo no declarado dentro de payment -> 400 por whitelist', async () => {
      await expectRejectedProperty(
        CreateSaleDto,
        {
          ...baseValid,
          payment: { method: 'CASH', amount: '10.00', paidAt: '2026-01-01' },
        },
        'paidAt',
      );
    });

    it('payment.status/saleId/createdBy no se aceptan (400 por whitelist)', async () => {
      await expectRejectedProperty(
        CreateSaleDto,
        {
          ...baseValid,
          payment: { method: 'CASH', amount: '10.00', status: 'ACTIVE' },
        },
        'status',
      );
    });
  });
});

describe('CreateSaleItemDto (a través de CreateSaleDto)', () => {
  it('productId ausente reporta error', async () => {
    const instance = plainToInstance(CreateSaleDto, {
      customerId: VALID_UUID,
      items: [{ quantity: '1' }],
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'items')).toBe(true);
  });
});

describe('CancelSaleDto', () => {
  it('motivo recortado válido no reporta errores', async () => {
    const instance = plainToInstance(CancelSaleDto, {
      reason: 'Cliente se arrepintió del pedido',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('motivo vacío reporta error', async () => {
    const instance = plainToInstance(CancelSaleDto, { reason: '' });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('motivo mayor a 200 caracteres reporta error', async () => {
    const instance = plainToInstance(CancelSaleDto, {
      reason: 'a'.repeat(201),
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('campo desconocido -> 400 por whitelist', async () => {
    await expectRejectedProperty(
      CancelSaleDto,
      { reason: 'Motivo válido', status: 'CANCELLED' },
      'status',
    );
  });

  it('cancelledAt/cancelledByUserId -> 400 por whitelist', async () => {
    await expectRejectedProperty(
      CancelSaleDto,
      { reason: 'Motivo válido', cancelledByUserId: VALID_UUID },
      'cancelledByUserId',
    );
  });
});

describe('ListSalesQueryDto', () => {
  it('vacío es válido (todo opcional)', async () => {
    const instance = plainToInstance(ListSalesQueryDto, {});
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('page/limit se convierten a número', async () => {
    const instance = plainToInstance(ListSalesQueryDto, {
      page: '2',
      limit: '50',
    });
    expect(instance.page).toBe(2);
    expect(instance.limit).toBe(50);
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('page < 1 reporta error', async () => {
    const instance = plainToInstance(ListSalesQueryDto, { page: '0' });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'page')).toBe(true);
  });

  it('limit < 1 reporta error', async () => {
    const instance = plainToInstance(ListSalesQueryDto, { limit: '0' });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it('limit > 100 reporta error', async () => {
    const instance = plainToInstance(ListSalesQueryDto, { limit: '101' });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it.each([SaleStatus.ACTIVE, SaleStatus.CANCELLED])(
    'status=%s es válido',
    async (status) => {
      const instance = plainToInstance(ListSalesQueryDto, { status });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    },
  );

  it('status inválido reporta error', async () => {
    const instance = plainToInstance(ListSalesQueryDto, {
      status: 'BOGUS',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'status')).toBe(true);
  });

  it.each([
    SalePaymentStatus.UNPAID,
    SalePaymentStatus.PARTIALLY_PAID,
    SalePaymentStatus.PAID,
  ])(
    'paymentStatus=%s es válido (incluida PARTIALLY_PAID, compatibilidad F7)',
    async (paymentStatus) => {
      const instance = plainToInstance(ListSalesQueryDto, { paymentStatus });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    },
  );

  it.each([
    SaleDeliveryStatus.NOT_APPLICABLE,
    SaleDeliveryStatus.PENDING,
    SaleDeliveryStatus.DELIVERED,
    SaleDeliveryStatus.OBSERVED,
  ])('deliveryStatus=%s es válido', async (deliveryStatus) => {
    const instance = plainToInstance(ListSalesQueryDto, { deliveryStatus });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it.each(['customerId', 'sellerId', 'quoteId'])(
    '%s inválido reporta error',
    async (field) => {
      const instance = plainToInstance(ListSalesQueryDto, {
        [field]: 'not-a-uuid',
      });
      const errors = await validate(instance);
      expect(errors.some((e) => e.property === field)).toBe(true);
    },
  );

  it.each(['customerId', 'sellerId', 'quoteId'])(
    '%s UUID válido es aceptado',
    async (field) => {
      const instance = plainToInstance(ListSalesQueryDto, {
        [field]: VALID_UUID,
      });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    },
  );

  describe('confirmedFrom / confirmedTo', () => {
    it('fecha exacta YYYY-MM-DD válida', async () => {
      const instance = plainToInstance(ListSalesQueryDto, {
        confirmedFrom: '2026-03-01',
        confirmedTo: '2026-03-31',
      });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    });

    it('fecha bisiesta válida (2024-02-29)', async () => {
      const instance = plainToInstance(ListSalesQueryDto, {
        confirmedFrom: '2024-02-29',
      });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    });

    it.each([
      ['30 de febrero', '2026-02-30'],
      ['29 de febrero no bisiesto', '2023-02-29'],
      ['con timestamp', '2026-08-10T10:00:00Z'],
      ['separador incorrecto', '2026/03/01'],
      ['sin ceros a la izquierda', '2026-3-1'],
      ['vacío', ''],
    ])('confirmedFrom inválido (%s) -> error', async (_label, value) => {
      const instance = plainToInstance(ListSalesQueryDto, {
        confirmedFrom: value,
      });
      const errors = await validate(instance);
      expect(errors.some((e) => e.property === 'confirmedFrom')).toBe(true);
    });

    it('confirmedTo con timestamp -> error', async () => {
      const instance = plainToInstance(ListSalesQueryDto, {
        confirmedTo: '2026-08-10T10:00:00Z',
      });
      const errors = await validate(instance);
      expect(errors.some((e) => e.property === 'confirmedTo')).toBe(true);
    });
  });

  it('search válido', async () => {
    const instance = plainToInstance(ListSalesQueryDto, {
      search: 'NV-000001',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('search mayor a 150 caracteres reporta error', async () => {
    const instance = plainToInstance(ListSalesQueryDto, {
      search: 'a'.repeat(151),
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'search')).toBe(true);
  });

  describe('whitelist — sin orden arbitrario', () => {
    it.each(['orderBy', 'sort', 'direction'])(
      '"%s" -> 400 por whitelist',
      async (field) => {
        await expectRejectedQueryProperty(
          ListSalesQueryDto,
          { [field]: 'asc' },
          field,
        );
      },
    );
  });
});

describe('ConvertQuoteToSaleDto', () => {
  it('sin cuerpo (undefined): el ValidationPipe real lo acepta (todos los campos son opcionales)', async () => {
    const pipe = createValidationPipe();
    await expect(
      pipe.transform(undefined, {
        type: 'body',
        metatype: ConvertQuoteToSaleDto,
      }),
    ).resolves.toBeDefined();
  });

  it('cuerpo {} : válido, sin errores', async () => {
    const instance = plainToInstance(ConvertQuoteToSaleDto, {});
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('cuerpo con payment válido: sin errores', async () => {
    const instance = plainToInstance(ConvertQuoteToSaleDto, {
      payment: { method: 'CASH', amount: '10.00' },
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('payment.amount malformado reporta error anidado', async () => {
    const instance = plainToInstance(ConvertQuoteToSaleDto, {
      payment: { method: 'CASH', amount: '-10.00' },
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'payment')).toBe(true);
  });

  it('customerId no se acepta -> 400 por whitelist', async () => {
    await expectRejectedProperty(
      ConvertQuoteToSaleDto,
      { customerId: VALID_UUID },
      'customerId',
    );
  });

  it('discountAmount no se acepta -> 400 por whitelist', async () => {
    await expectRejectedProperty(
      ConvertQuoteToSaleDto,
      { discountAmount: '10.00' },
      'discountAmount',
    );
  });

  it('items no se acepta -> 400 por whitelist', async () => {
    await expectRejectedProperty(
      ConvertQuoteToSaleDto,
      { items: [{ productId: VALID_UUID_2, quantity: '1' }] },
      'items',
    );
  });

  it('campo desconocido dentro de payment -> 400 por whitelist', async () => {
    await expectRejectedProperty(
      ConvertQuoteToSaleDto,
      { payment: { method: 'CASH', amount: '10.00', saleId: VALID_UUID } },
      'saleId',
    );
  });
});

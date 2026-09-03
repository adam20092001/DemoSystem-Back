import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createValidationPipe } from '../../common/pipes/validation.pipe';
import { CancelPaymentDto } from './cancel-payment.dto';
import { CreatePaymentDto } from './create-payment.dto';
import { InitialPaymentDto } from './initial-payment.dto';
import { ListPaymentsQueryDto } from './list-payments-query.dto';
import { ListReceivablesQueryDto } from './list-receivables-query.dto';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

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

describe('CreatePaymentDto', () => {
  it.each(['CASH', 'CARD', 'TRANSFER', 'YAPE', 'PLIN', 'CUSTOM_METHOD'])(
    'método dinámico %s con monto válido: sin errores (formato/existencia/actividad se validan en el dominio, no aquí)',
    async (method) => {
      const instance = plainToInstance(CreatePaymentDto, {
        method,
        amount: '10.00',
      });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    },
  );

  it('method en minúsculas pasa la validación del DTO: la normalización (trim+mayúsculas) y el formato canónico se validan en el dominio (Ticket C, Bloque C3)', async () => {
    const instance = plainToInstance(CreatePaymentDto, {
      method: 'cash',
      amount: '10.00',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('method vacío reporta error', async () => {
    const instance = plainToInstance(CreatePaymentDto, {
      method: '',
      amount: '10.00',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'method')).toBe(true);
  });

  it('method de más de 30 caracteres reporta error', async () => {
    const instance = plainToInstance(CreatePaymentDto, {
      method: 'A'.repeat(31),
      amount: '10.00',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'method')).toBe(true);
  });

  it('method ausente reporta error', async () => {
    const instance = plainToInstance(CreatePaymentDto, { amount: '10.00' });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'method')).toBe(true);
  });

  it.each([
    ['entero', '10'],
    ['un decimal', '10.5'],
    ['dos decimales', '10.99'],
  ])('amount con forma válida (%s): sin errores', async (_label, amount) => {
    const instance = plainToInstance(CreatePaymentDto, {
      method: 'CASH',
      amount,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it.each([
    ['negativo', '-10.00'],
    ['notación científica', '1e2'],
    ['coma decimal', '10,00'],
    ['más de 2 decimales', '10.999'],
    ['no numérico', 'abc'],
    ['vacío', ''],
    ['signo positivo explícito', '+10.00'],
  ])('amount malformado (%s) reporta error', async (_label, amount) => {
    const instance = plainToInstance(CreatePaymentDto, {
      method: 'CASH',
      amount,
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'amount')).toBe(true);
  });

  it('reference ausente es válida (la forma HTTP no exige referencia por método; eso lo valida el dominio)', async () => {
    const instance = plainToInstance(CreatePaymentDto, {
      method: 'TRANSFER',
      amount: '10.00',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('reference presente y válida', async () => {
    const instance = plainToInstance(CreatePaymentDto, {
      method: 'CASH',
      amount: '10.00',
      reference: 'OP-000123',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('reference de longitud exactamente 100 es válida', async () => {
    const instance = plainToInstance(CreatePaymentDto, {
      method: 'CASH',
      amount: '10.00',
      reference: 'a'.repeat(100),
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('reference de longitud 101 reporta error', async () => {
    const instance = plainToInstance(CreatePaymentDto, {
      method: 'CASH',
      amount: '10.00',
      reference: 'a'.repeat(101),
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'reference')).toBe(true);
  });

  describe('whitelist — campos de sistema nunca aceptados', () => {
    it.each([
      'saleId',
      'paidAt',
      'status',
      'createdByUserId',
      'createdBy',
      'cancelledAt',
      'cancellationReason',
      'cancellationSource',
      'cancelledBy',
      'id',
    ])('"%s" -> 400 por whitelist', async (field) => {
      await expectRejectedProperty(
        CreatePaymentDto,
        { method: 'CASH', amount: '10.00', [field]: 'x' },
        field,
      );
    });
  });
});

describe('InitialPaymentDto', () => {
  it('mismo contrato que CreatePaymentDto: válido con method/amount', async () => {
    const instance = plainToInstance(InitialPaymentDto, {
      method: 'CASH',
      amount: '10.00',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('amount malformado reporta error (misma validación heredada)', async () => {
    const instance = plainToInstance(InitialPaymentDto, {
      method: 'CASH',
      amount: '10,00',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'amount')).toBe(true);
  });
});

describe('CancelPaymentDto', () => {
  it('motivo válido no reporta errores', async () => {
    const instance = plainToInstance(CancelPaymentDto, {
      reason: 'Pago registrado por error',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('motivo ausente reporta error', async () => {
    const instance = plainToInstance(CancelPaymentDto, {});
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('motivo vacío reporta error', async () => {
    const instance = plainToInstance(CancelPaymentDto, { reason: '' });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('motivo solo espacios pasa el DTO (IsNotEmpty), pero el dominio lo rechaza igual', async () => {
    const instance = plainToInstance(CancelPaymentDto, { reason: '   ' });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('motivo de longitud exactamente 200 es válido', async () => {
    const instance = plainToInstance(CancelPaymentDto, {
      reason: 'a'.repeat(200),
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('motivo de longitud 201 reporta error', async () => {
    const instance = plainToInstance(CancelPaymentDto, {
      reason: 'a'.repeat(201),
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('cancellationSource -> 400 por whitelist (nunca lo elige el cliente)', async () => {
    await expectRejectedProperty(
      CancelPaymentDto,
      { reason: 'motivo', cancellationSource: 'MANUAL' },
      'cancellationSource',
    );
  });
});

describe('ListPaymentsQueryDto', () => {
  it('query vacía es válida (todos los campos opcionales)', async () => {
    const instance = plainToInstance(ListPaymentsQueryDto, {});
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('page/limit válidos', async () => {
    const instance = plainToInstance(ListPaymentsQueryDto, {
      page: '2',
      limit: '50',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('page < 1 reporta error', async () => {
    const instance = plainToInstance(ListPaymentsQueryDto, { page: '0' });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'page')).toBe(true);
  });

  it('limit > 100 reporta error', async () => {
    const instance = plainToInstance(ListPaymentsQueryDto, { limit: '500' });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it('method/status válidos', async () => {
    const instance = plainToInstance(ListPaymentsQueryDto, {
      method: 'CARD',
      status: PaymentStatus.CANCELLED,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('method con formato de código dinámico arbitrario: sin errores (el filtro se resuelve contra el snapshot, no se valida existencia aquí)', async () => {
    const instance = plainToInstance(ListPaymentsQueryDto, {
      method: 'NOT_A_METHOD',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('method de más de 30 caracteres reporta error', async () => {
    const instance = plainToInstance(ListPaymentsQueryDto, {
      method: 'A'.repeat(31),
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'method')).toBe(true);
  });

  it('createdByUserId debe ser UUID válido', async () => {
    const instance = plainToInstance(ListPaymentsQueryDto, {
      createdByUserId: 'not-a-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'createdByUserId')).toBe(true);
  });

  it('createdByUserId UUID válido: sin errores', async () => {
    const instance = plainToInstance(ListPaymentsQueryDto, {
      createdByUserId: VALID_UUID,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('paidFrom/paidTo con formato YYYY-MM-DD válido: sin errores', async () => {
    const instance = plainToInstance(ListPaymentsQueryDto, {
      paidFrom: '2026-03-01',
      paidTo: '2026-03-31',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it.each([
    ['30 de febrero', '2026-02-30'],
    ['con timestamp', '2026-08-10T10:00:00Z'],
    ['separador incorrecto', '2026/08/09'],
  ])('paidFrom inválida (%s) reporta error', async (_label, paidFrom) => {
    const instance = plainToInstance(ListPaymentsQueryDto, { paidFrom });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'paidFrom')).toBe(true);
  });

  describe('whitelist — sin search/sort/orderBy/direction/amount/reference/customerId/sellerId', () => {
    it.each([
      'search',
      'sort',
      'orderBy',
      'direction',
      'amount',
      'reference',
      'customerId',
      'sellerId',
    ])('"%s" -> 400 por whitelist', async (field) => {
      await expectRejectedQueryProperty(
        ListPaymentsQueryDto,
        { [field]: 'x' },
        field,
      );
    });
  });
});

describe('ListReceivablesQueryDto', () => {
  it('query vacía es válida', async () => {
    const instance = plainToInstance(ListReceivablesQueryDto, {});
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('customerId/sellerId UUID válidos: sin errores', async () => {
    const instance = plainToInstance(ListReceivablesQueryDto, {
      customerId: VALID_UUID,
      sellerId: VALID_UUID,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('customerId inválido reporta error', async () => {
    const instance = plainToInstance(ListReceivablesQueryDto, {
      customerId: 'not-a-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'customerId')).toBe(true);
  });

  it('confirmedFrom/confirmedTo válidos: sin errores', async () => {
    const instance = plainToInstance(ListReceivablesQueryDto, {
      confirmedFrom: '2026-03-01',
      confirmedTo: '2026-03-31',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('confirmedFrom con timestamp reporta error (solo YYYY-MM-DD)', async () => {
    const instance = plainToInstance(ListReceivablesQueryDto, {
      confirmedFrom: '2026-08-10T10:00:00Z',
    });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'confirmedFrom')).toBe(true);
  });

  describe('whitelist — sin status/paymentStatus/method/minBalance/search/orderBy/direction/aging/dueDate', () => {
    it.each([
      'status',
      'paymentStatus',
      'method',
      'minBalance',
      'search',
      'orderBy',
      'direction',
      'aging',
      'dueDate',
    ])('"%s" -> 400 por whitelist', async (field) => {
      await expectRejectedQueryProperty(
        ListReceivablesQueryDto,
        { [field]: 'x' },
        field,
      );
    });
  });
});

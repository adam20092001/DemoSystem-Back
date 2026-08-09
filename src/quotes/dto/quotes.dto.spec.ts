import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { QuoteStatus } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createValidationPipe } from '../../common/pipes/validation.pipe';
import { CreateQuoteDto } from './create-quote.dto';
import { ListQuotesQueryDto } from './list-quotes-query.dto';
import { UpdateQuoteDto } from './update-quote.dto';

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

describe('CreateQuoteDto', () => {
  const baseValid = {
    customerId: VALID_UUID,
    expirationDate: '2026-04-15',
    items: [{ productId: VALID_UUID_2, quantity: '2.500' }],
  };

  it('cotización válida no reporta errores', async () => {
    const instance = plainToInstance(CreateQuoteDto, baseValid);
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('múltiples ítems válidos', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      items: [
        { productId: VALID_UUID_2, quantity: '1' },
        { productId: VALID_UUID, quantity: '2.250' },
      ],
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('fecha exacta YYYY-MM-DD válida', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      expirationDate: '2026-12-31',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('fecha bisiesta válida (29 de febrero)', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      expirationDate: '2024-02-29',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('30 de febrero es inválida', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      expirationDate: '2026-02-30',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'expirationDate')).toBe(
      true,
    );
  });

  it('timestamp (con hora/zona) es rechazado: no es date-only', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      expirationDate: '2026-08-09T12:00:00Z',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'expirationDate')).toBe(
      true,
    );
  });

  it('separador incorrecto (2026/08/09) es rechazado', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      expirationDate: '2026/08/09',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'expirationDate')).toBe(
      true,
    );
  });

  it('29 de febrero en año no bisiesto es inválida', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      expirationDate: '2026-02-29',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'expirationDate')).toBe(
      true,
    );
  });

  it('customerId inválido (no UUID) -> error', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      customerId: 'not-a-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'customerId')).toBe(true);
  });

  it('items vacío ([]) -> error', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      items: [],
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'items')).toBe(true);
  });

  it('items ausente -> error', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      customerId: VALID_UUID,
      expirationDate: '2026-04-15',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'items')).toBe(true);
  });

  it('quantity malformada dentro del ítem anidado -> error', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      items: [{ productId: VALID_UUID_2, quantity: 'abc' }],
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'items')).toBe(true);
  });

  it('quantity con notación científica -> error', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      items: [{ productId: VALID_UUID_2, quantity: '1e3' }],
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'items')).toBe(true);
  });

  it('quantity con coma decimal -> error', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      items: [{ productId: VALID_UUID_2, quantity: '1,25' }],
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'items')).toBe(true);
  });

  it('quantity con más de 3 decimales -> error', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      items: [{ productId: VALID_UUID_2, quantity: '1.2345' }],
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'items')).toBe(true);
  });

  it('discountAmount malformado -> error', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      discountAmount: 'abc',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'discountAmount')).toBe(
      true,
    );
  });

  it('discountAmount con notación científica -> error', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      discountAmount: '1E3',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'discountAmount')).toBe(
      true,
    );
  });

  it('discountAmount con coma decimal -> error', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      discountAmount: '10,50',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'discountAmount')).toBe(
      true,
    );
  });

  it('discountAmount con más de 2 decimales -> error', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      discountAmount: '10.505',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'discountAmount')).toBe(
      true,
    );
  });

  it('discountAmount válido no reporta errores', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      discountAmount: '15.50',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('notes mayor a 1000 caracteres -> error', async () => {
    const instance = plainToInstance(CreateQuoteDto, {
      ...baseValid,
      notes: 'a'.repeat(1001),
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'notes')).toBe(true);
  });

  it('propiedad desconocida es rechazada por el ValidationPipe global (whitelist)', async () => {
    await expectRejectedProperty(
      CreateQuoteDto,
      { ...baseValid, unexpectedField: 'algo' },
      'unexpectedField',
    );
  });

  it.each([
    'number',
    'status',
    'sellerId',
    'issueDate',
    'subtotal',
    'taxAmount',
    'total',
  ])(
    'campo prohibido de cabecera "%s" es rechazado por el ValidationPipe global',
    async (field) => {
      await expectRejectedProperty(
        CreateQuoteDto,
        { ...baseValid, [field]: 'valor-arbitrario' },
        field,
      );
    },
  );

  it.each(['unitPrice', 'lineTotal', 'productName', 'productSku', 'stockInfo'])(
    'campo prohibido de ítem anidado "%s" es rechazado por el ValidationPipe global',
    async (field) => {
      await expectRejectedProperty(
        CreateQuoteDto,
        {
          ...baseValid,
          items: [{ productId: VALID_UUID_2, quantity: '1', [field]: 'x' }],
        },
        field,
      );
    },
  );
});

describe('UpdateQuoteDto', () => {
  it('campos aprobados son aceptados', async () => {
    const instance = plainToInstance(UpdateQuoteDto, {
      expirationDate: '2026-05-01',
      discountAmount: '5.00',
      notes: 'Nota',
      items: [{ productId: VALID_UUID_2, quantity: '1' }],
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('objeto vacío es válido a nivel de DTO (QuotesService rechaza con 400)', async () => {
    const instance = plainToInstance(UpdateQuoteDto, {});
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('items ausente es válido (se conservan los actuales)', async () => {
    const instance = plainToInstance(UpdateQuoteDto, { notes: 'Solo notas' });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('items [] es rechazado', async () => {
    const instance = plainToInstance(UpdateQuoteDto, { items: [] });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'items')).toBe(true);
  });

  it('expirationDate inválida (30 de febrero) -> error', async () => {
    const instance = plainToInstance(UpdateQuoteDto, {
      expirationDate: '2026-02-30',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'expirationDate')).toBe(
      true,
    );
  });

  it('discountAmount inválido -> error', async () => {
    const instance = plainToInstance(UpdateQuoteDto, {
      discountAmount: '1e1',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'discountAmount')).toBe(
      true,
    );
  });

  it.each([
    'customerId',
    'sellerId',
    'number',
    'status',
    'issueDate',
    'subtotal',
    'taxAmount',
    'total',
  ])(
    'campo prohibido "%s" es rechazado por el ValidationPipe global',
    async (field) => {
      await expectRejectedProperty(
        UpdateQuoteDto,
        { notes: 'x', [field]: 'valor-arbitrario' },
        field,
      );
    },
  );

  it.each(['customerType', 'customerName', 'customerDocumentNumber'])(
    'snapshot prohibido "%s" es rechazado por el ValidationPipe global',
    async (field) => {
      await expectRejectedProperty(
        UpdateQuoteDto,
        { notes: 'x', [field]: 'valor-arbitrario' },
        field,
      );
    },
  );
});

describe('ListQuotesQueryDto', () => {
  it('page/limit se transforman a enteros', async () => {
    const instance = plainToInstance(ListQuotesQueryDto, {
      page: '2',
      limit: '50',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
    expect(instance.page).toBe(2);
    expect(instance.limit).toBe(50);
  });

  it('page < 1 -> error', async () => {
    const instance = plainToInstance(ListQuotesQueryDto, { page: '0' });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'page')).toBe(true);
  });

  it('limit < 1 -> error', async () => {
    const instance = plainToInstance(ListQuotesQueryDto, { limit: '0' });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });

  it('limit > 100 -> error', async () => {
    const instance = plainToInstance(ListQuotesQueryDto, { limit: '500' });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });

  it('status inválido -> error @IsEnum', async () => {
    const instance = plainToInstance(ListQuotesQueryDto, {
      status: 'NOT_A_STATUS',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'status')).toBe(true);
  });

  it('status válido no reporta errores', async () => {
    const instance = plainToInstance(ListQuotesQueryDto, {
      status: QuoteStatus.ACCEPTED,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('customerId inválido (no UUID) -> error', async () => {
    const instance = plainToInstance(ListQuotesQueryDto, {
      customerId: 'not-a-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'customerId')).toBe(true);
  });

  it('sellerId inválido (no UUID) -> error', async () => {
    const instance = plainToInstance(ListQuotesQueryDto, {
      sellerId: 'not-a-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'sellerId')).toBe(true);
  });

  it('customerId/sellerId UUID válidos no reportan errores', async () => {
    const instance = plainToInstance(ListQuotesQueryDto, {
      customerId: VALID_UUID,
      sellerId: VALID_UUID_2,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it.each([
    'issueDateFrom',
    'issueDateTo',
    'expirationDateFrom',
    'expirationDateTo',
  ])('%s válido no reporta errores', async (field) => {
    const instance = plainToInstance(ListQuotesQueryDto, {
      [field]: '2026-01-15',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it.each([
    'issueDateFrom',
    'issueDateTo',
    'expirationDateFrom',
    'expirationDateTo',
  ])('%s con calendario real inválido (2026-02-30) -> error', async (field) => {
    const instance = plainToInstance(ListQuotesQueryDto, {
      [field]: '2026-02-30',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === field)).toBe(true);
  });

  it('search se acepta como string', async () => {
    const instance = plainToInstance(ListQuotesQueryDto, {
      search: 'COT-0001',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('payload vacío es válido: todos los filtros son opcionales', async () => {
    const instance = plainToInstance(ListQuotesQueryDto, {});
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('propiedad desconocida es rechazada por el ValidationPipe global', async () => {
    await expectRejectedProperty(
      ListQuotesQueryDto,
      { unexpectedField: 'algo' },
      'unexpectedField',
    );
  });

  it.each(['orderBy', 'sort', 'direction'])(
    '%s es rechazado por el ValidationPipe global (whitelist)',
    async (field) => {
      await expectRejectedProperty(
        ListQuotesQueryDto,
        { [field]: 'number' },
        field,
      );
    },
  );
});

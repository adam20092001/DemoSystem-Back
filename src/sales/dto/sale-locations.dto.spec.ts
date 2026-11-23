import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConvertQuoteToSaleDto } from './convert-quote-to-sale.dto';
import { CreateSaleItemDto } from './create-sale-item.dto';
import { CreateSaleDto } from './create-sale.dto';

const PRODUCT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LOCATION_ID = '10000000-0000-4000-8000-00000000000a';

function strictPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
}

describe('CreateSaleItemDto (R2-B3: locationId)', () => {
  const errorsOf = (payload: Record<string, unknown>) =>
    validate(plainToInstance(CreateSaleItemDto, payload));

  it('acepta locationId UUID válido', async () => {
    expect(
      await errorsOf({
        productId: PRODUCT_ID,
        quantity: '1',
        locationId: LOCATION_ID,
      }),
    ).toHaveLength(0);
  });

  it('acepta la línea sin locationId (compatibilidad)', async () => {
    expect(
      await errorsOf({ productId: PRODUCT_ID, quantity: '1' }),
    ).toHaveLength(0);
  });

  it('rechaza un locationId que no es UUID', async () => {
    const errors = await errorsOf({
      productId: PRODUCT_ID,
      quantity: '1',
      locationId: 'no-es-uuid',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('locationId');
  });

  it('con el ValidationPipe global rechaza atributos de ubicación desconocidos y un locationId en la cabecera', async () => {
    await expect(
      strictPipe().transform(
        {
          customerId: CUSTOMER_ID,
          items: [{ productId: PRODUCT_ID, quantity: '1', warehouseId: '1' }],
        },
        { type: 'body', metatype: CreateSaleDto },
      ),
    ).rejects.toThrow();
    await expect(
      strictPipe().transform(
        {
          customerId: CUSTOMER_ID,
          locationId: LOCATION_ID,
          items: [{ productId: PRODUCT_ID, quantity: '1' }],
        },
        { type: 'body', metatype: CreateSaleDto },
      ),
    ).rejects.toThrow();
  });
});

describe('ConvertQuoteToSaleDto (R2-B3: locations)', () => {
  const transform = (body: Record<string, unknown>) =>
    strictPipe().transform(body, {
      type: 'body',
      metatype: ConvertQuoteToSaleDto,
    });

  it('acepta el cuerpo vacío y el cuerpo antiguo con pagos (compatibilidad)', async () => {
    await expect(transform({})).resolves.toBeDefined();
    await expect(
      transform({ payment: { method: 'CASH', amount: '10.00' } }),
    ).resolves.toBeDefined();
  });

  it('acepta locations válidas', async () => {
    await expect(
      transform({
        locations: [{ productId: PRODUCT_ID, locationId: LOCATION_ID }],
      }),
    ).resolves.toBeDefined();
  });

  it('rechaza UUID inválidos, campos desconocidos y elementos que no son objetos', async () => {
    await expect(
      transform({ locations: [{ productId: 'x', locationId: LOCATION_ID }] }),
    ).rejects.toThrow();
    await expect(
      transform({ locations: [{ productId: PRODUCT_ID, locationId: 'x' }] }),
    ).rejects.toThrow();
    await expect(
      transform({
        locations: [
          { productId: PRODUCT_ID, locationId: LOCATION_ID, extra: true },
        ],
      }),
    ).rejects.toThrow();
    await expect(transform({ locations: 'no-es-arreglo' })).rejects.toThrow();
  });
});

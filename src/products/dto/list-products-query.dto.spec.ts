import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListProductsQueryDto } from './list-products-query.dto';

async function validateIsInventoryTracked(value: unknown): Promise<{
  transformed: unknown;
  errors: unknown[];
}> {
  const instance = plainToInstance(ListProductsQueryDto, {
    isInventoryTracked: value,
  });
  const errors = await validate(instance);
  return { transformed: instance.isInventoryTracked, errors };
}

describe('ListProductsQueryDto — isInventoryTracked (usa el helper compartido toStrictBoolean)', () => {
  it('"true" se transforma a true y valida sin errores', async () => {
    const { transformed, errors } = await validateIsInventoryTracked('true');
    expect(transformed).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('"false" se transforma a false y valida sin errores', async () => {
    const { transformed, errors } = await validateIsInventoryTracked('false');
    expect(transformed).toBe(false);
    expect(errors).toHaveLength(0);
  });

  it('true (boolean) permanece true y valida sin errores', async () => {
    const { transformed, errors } = await validateIsInventoryTracked(true);
    expect(transformed).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('false (boolean) permanece false y valida sin errores', async () => {
    const { transformed, errors } = await validateIsInventoryTracked(false);
    expect(transformed).toBe(false);
    expect(errors).toHaveLength(0);
  });

  it('campo ausente permanece undefined y no reporta error (@IsOptional)', async () => {
    const instance = plainToInstance(ListProductsQueryDto, {});
    const errors = await validate(instance);
    expect(instance.isInventoryTracked).toBeUndefined();
    expect(errors).toHaveLength(0);
  });

  it.each(['0', '1', 'yes', 'abc', ''])(
    'valor inválido %j no pasa la validación @IsBoolean',
    async (value) => {
      const { errors } = await validateIsInventoryTracked(value);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.constraints).toHaveProperty('isBoolean');
    },
  );
});

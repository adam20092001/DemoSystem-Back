import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListUnitsQueryDto } from './list-units-query.dto';

async function validateAllowDecimal(value: unknown): Promise<{
  transformed: unknown;
  errors: unknown[];
}> {
  const instance = plainToInstance(ListUnitsQueryDto, { allowDecimal: value });
  const errors = await validate(instance);
  return { transformed: instance.allowDecimal, errors };
}

describe('ListUnitsQueryDto — allowDecimal (usa el helper compartido toStrictBoolean)', () => {
  it('"true" se transforma a true y valida sin errores', async () => {
    const { transformed, errors } = await validateAllowDecimal('true');
    expect(transformed).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('"false" se transforma a false y valida sin errores', async () => {
    const { transformed, errors } = await validateAllowDecimal('false');
    expect(transformed).toBe(false);
    expect(errors).toHaveLength(0);
  });

  it('true (boolean) permanece true y valida sin errores', async () => {
    const { transformed, errors } = await validateAllowDecimal(true);
    expect(transformed).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('false (boolean) permanece false y valida sin errores', async () => {
    const { transformed, errors } = await validateAllowDecimal(false);
    expect(transformed).toBe(false);
    expect(errors).toHaveLength(0);
  });

  it('campo ausente permanece undefined y no reporta error (@IsOptional)', async () => {
    const instance = plainToInstance(ListUnitsQueryDto, {});
    const errors = await validate(instance);
    expect(instance.allowDecimal).toBeUndefined();
    expect(errors).toHaveLength(0);
  });

  it.each(['0', '1', 'yes', 'abc', ''])(
    'valor inválido %j no pasa la validación @IsBoolean',
    async (value) => {
      const { errors } = await validateAllowDecimal(value);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.constraints).toHaveProperty('isBoolean');
    },
  );
});

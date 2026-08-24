import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createValidationPipe } from '../../common/pipes/validation.pipe';
import { DashboardQueryDto } from './dashboard-query.dto';

async function expectRejectedQueryProperty(
  payload: Record<string, unknown>,
  offendingProperty: string,
): Promise<void> {
  const pipe = createValidationPipe();
  expect.assertions(2);
  try {
    await pipe.transform(payload, {
      type: 'query',
      metatype: DashboardQueryDto,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as {
      message: string[];
    };
    expect(body.message.join(' ')).toMatch(new RegExp(offendingProperty));
  }
}

describe('DashboardQueryDto', () => {
  it('ambos omitidos: válido a nivel de DTO (el default de mes actual lo resuelve el servicio)', async () => {
    const instance = plainToInstance(DashboardQueryDto, {});
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('from y to válidos: sin errores', async () => {
    const instance = plainToInstance(DashboardQueryDto, {
      from: '2026-08-01',
      to: '2026-08-23',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('from solo (sin to) es válido A NIVEL DE DTO: la regla ambos-o-ninguno la aplica el servicio, no el DTO', async () => {
    const instance = plainToInstance(DashboardQueryDto, {
      from: '2026-08-01',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('to solo (sin from) es válido A NIVEL DE DTO por el mismo motivo', async () => {
    const instance = plainToInstance(DashboardQueryDto, {
      to: '2026-08-23',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it.each([
    ['30 de febrero', '2026-02-30'],
    ['con timestamp', '2026-08-10T10:00:00Z'],
    ['separador incorrecto', '2026/08/09'],
  ])('from inválida (%s) reporta error', async (_label, from) => {
    const instance = plainToInstance(DashboardQueryDto, { from });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'from')).toBe(true);
  });

  it.each([
    ['30 de febrero', '2026-02-30'],
    ['con timestamp', '2026-08-10T10:00:00Z'],
    ['separador incorrecto', '2026/08/09'],
  ])('to inválida (%s) reporta error', async (_label, to) => {
    const instance = plainToInstance(DashboardQueryDto, { to });
    const errors = await validate(instance);
    expect(errors.some((e) => e.property === 'to')).toBe(true);
  });

  it('page no es un campo válido: el Dashboard no es un listado paginado', async () => {
    await expectRejectedQueryProperty({ page: '1' }, 'page');
  });

  it('limit no es un campo válido: el Dashboard no es un listado paginado', async () => {
    await expectRejectedQueryProperty({ limit: '20' }, 'limit');
  });

  it('campo desconocido -> 400 por whitelist', async () => {
    await expectRejectedQueryProperty({ notAField: 'x' }, 'notAField');
  });
});

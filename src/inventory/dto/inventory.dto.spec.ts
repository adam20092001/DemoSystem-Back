import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { ProductStatus } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createValidationPipe } from '../../common/pipes/validation.pipe';
import { ListLowStockQueryDto } from './list-low-stock-query.dto';
import { ListMovementsQueryDto } from './list-movements-query.dto';
import { RegisterAdjustmentInDto } from './register-adjustment-in.dto';
import { RegisterAdjustmentOutDto } from './register-adjustment-out.dto';
import { RegisterEntryDto } from './register-entry.dto';
import { RegisterExitDto } from './register-exit.dto';
import { RegisterInitialBalanceDto } from './register-initial-balance.dto';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

type WriteDto = {
  productId: string;
  quantity: string;
  reason: string;
  notes?: string;
};
type WriteDtoCtor = new () => WriteDto;

const WRITE_DTOS: [string, WriteDtoCtor][] = [
  ['RegisterInitialBalanceDto', RegisterInitialBalanceDto],
  ['RegisterEntryDto', RegisterEntryDto],
  ['RegisterExitDto', RegisterExitDto],
  ['RegisterAdjustmentInDto', RegisterAdjustmentInDto],
  ['RegisterAdjustmentOutDto', RegisterAdjustmentOutDto],
];

/**
 * Prueba concentrada de los 5 DTOs de escritura (misma forma exacta) en un
 * solo archivo, en vez de un spec por DTO, siguiendo el patrón de
 * list-products-query.dto.spec.ts (plainToInstance + class-validator).
 */
describe('DTOs de escritura de inventario', () => {
  it.each(WRITE_DTOS)(
    '%s: payload válido no reporta errores',
    async (_name, Dto) => {
      const instance = plainToInstance(Dto, {
        productId: VALID_UUID,
        quantity: '5.000',
        reason: 'Motivo válido',
        notes: 'Notas',
      });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    },
  );

  it.each(WRITE_DTOS)('%s: productId inválido → error', async (_name, Dto) => {
    const instance = plainToInstance(Dto, {
      productId: 'not-a-uuid',
      quantity: '5.000',
      reason: 'Motivo válido',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'productId')).toBe(true);
  });

  it.each(WRITE_DTOS)('%s: quantity no string → error', async (_name, Dto) => {
    const instance = plainToInstance(Dto, {
      productId: VALID_UUID,
      quantity: 5,
      reason: 'Motivo válido',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'quantity')).toBe(true);
  });

  it.each(WRITE_DTOS)('%s: quantity negativa → error', async (_name, Dto) => {
    const instance = plainToInstance(Dto, {
      productId: VALID_UUID,
      quantity: '-1.000',
      reason: 'Motivo válido',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'quantity')).toBe(true);
  });

  it.each(WRITE_DTOS)(
    '%s: quantity con más de 3 decimales → error',
    async (_name, Dto) => {
      const instance = plainToInstance(Dto, {
        productId: VALID_UUID,
        quantity: '1.2345',
        reason: 'Motivo válido',
      });
      const errors = await validate(instance);
      expect(errors.some((error) => error.property === 'quantity')).toBe(true);
    },
  );

  it.each(WRITE_DTOS)(
    '%s: quantity con más de 11 dígitos enteros → error',
    async (_name, Dto) => {
      const instance = plainToInstance(Dto, {
        productId: VALID_UUID,
        quantity: '123456789012',
        reason: 'Motivo válido',
      });
      const errors = await validate(instance);
      expect(errors.some((error) => error.property === 'quantity')).toBe(true);
    },
  );

  it.each(WRITE_DTOS)(
    '%s: quantity con notación científica → error',
    async (_name, Dto) => {
      const instance = plainToInstance(Dto, {
        productId: VALID_UUID,
        quantity: '1e3',
        reason: 'Motivo válido',
      });
      const errors = await validate(instance);
      expect(errors.some((error) => error.property === 'quantity')).toBe(true);
    },
  );

  it.each(WRITE_DTOS)('%s: reason vacío → error', async (_name, Dto) => {
    const instance = plainToInstance(Dto, {
      productId: VALID_UUID,
      quantity: '5.000',
      reason: '',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'reason')).toBe(true);
  });

  it.each(WRITE_DTOS)(
    '%s: reason mayor a 200 caracteres → error',
    async (_name, Dto) => {
      const instance = plainToInstance(Dto, {
        productId: VALID_UUID,
        quantity: '5.000',
        reason: 'a'.repeat(201),
      });
      const errors = await validate(instance);
      expect(errors.some((error) => error.property === 'reason')).toBe(true);
    },
  );

  it.each(WRITE_DTOS)(
    '%s: notes mayor a 500 caracteres → error',
    async (_name, Dto) => {
      const instance = plainToInstance(Dto, {
        productId: VALID_UUID,
        quantity: '5.000',
        reason: 'Motivo válido',
        notes: 'a'.repeat(501),
      });
      const errors = await validate(instance);
      expect(errors.some((error) => error.property === 'notes')).toBe(true);
    },
  );

  it('campo adicional movementType es rechazado por la configuración global (whitelist + forbidNonWhitelisted)', async () => {
    const pipe = createValidationPipe();
    expect.assertions(2);

    try {
      await pipe.transform(
        {
          productId: VALID_UUID,
          quantity: '5.000',
          reason: 'Motivo válido',
          movementType: 'ENTRY',
        },
        { type: 'body', metatype: RegisterEntryDto },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as {
        message: string[];
      };
      expect(body.message.join(' ')).toMatch(/movementType/);
    }
  });

  it('campo adicional origin es rechazado por la configuración global (whitelist + forbidNonWhitelisted)', async () => {
    const pipe = createValidationPipe();
    expect.assertions(2);

    try {
      await pipe.transform(
        {
          productId: VALID_UUID,
          quantity: '5.000',
          reason: 'Motivo válido',
          origin: 'MANUAL',
        },
        { type: 'body', metatype: RegisterEntryDto },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as {
        message: string[];
      };
      expect(body.message.join(' ')).toMatch(/origin/);
    }
  });
});

describe('ListMovementsQueryDto', () => {
  it('page/limit se transforman a enteros', async () => {
    const instance = plainToInstance(ListMovementsQueryDto, {
      page: '2',
      limit: '50',
    });

    const errors = await validate(instance);

    expect(errors).toHaveLength(0);
    expect(instance.page).toBe(2);
    expect(instance.limit).toBe(50);
  });

  it('page menor que 1 → error', async () => {
    const instance = plainToInstance(ListMovementsQueryDto, { page: '0' });

    const errors = await validate(instance);

    expect(errors.some((error) => error.property === 'page')).toBe(true);
  });

  it('limit mayor que 100 → error', async () => {
    const instance = plainToInstance(ListMovementsQueryDto, { limit: '500' });

    const errors = await validate(instance);

    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });

  it('movementType inválido → error @IsEnum', async () => {
    const instance = plainToInstance(ListMovementsQueryDto, {
      movementType: 'NOT_A_TYPE',
    });

    const errors = await validate(instance);

    expect(errors.some((error) => error.property === 'movementType')).toBe(
      true,
    );
  });

  it('origin inválido → error @IsEnum', async () => {
    const instance = plainToInstance(ListMovementsQueryDto, {
      origin: 'NOT_AN_ORIGIN',
    });

    const errors = await validate(instance);

    expect(errors.some((error) => error.property === 'origin')).toBe(true);
  });

  it('productId inválido (UUID) → error', async () => {
    const instance = plainToInstance(ListMovementsQueryDto, {
      productId: 'not-a-uuid',
    });

    const errors = await validate(instance);

    expect(errors.some((error) => error.property === 'productId')).toBe(true);
  });

  it('createdByUserId inválido (UUID) → error', async () => {
    const instance = plainToInstance(ListMovementsQueryDto, {
      createdByUserId: 'not-a-uuid',
    });

    const errors = await validate(instance);

    expect(errors.some((error) => error.property === 'createdByUserId')).toBe(
      true,
    );
  });

  it('dateFrom inválido (no ISO 8601) → error', async () => {
    const instance = plainToInstance(ListMovementsQueryDto, {
      dateFrom: 'no-es-una-fecha',
    });

    const errors = await validate(instance);

    expect(errors.some((error) => error.property === 'dateFrom')).toBe(true);
  });

  it('payload vacío es válido: todos los filtros son opcionales', async () => {
    const instance = plainToInstance(ListMovementsQueryDto, {});

    const errors = await validate(instance);

    expect(errors).toHaveLength(0);
  });
});

describe('ListLowStockQueryDto', () => {
  it('page/limit se transforman a enteros', async () => {
    const instance = plainToInstance(ListLowStockQueryDto, {
      page: '3',
      limit: '10',
    });

    const errors = await validate(instance);

    expect(errors).toHaveLength(0);
    expect(instance.page).toBe(3);
    expect(instance.limit).toBe(10);
  });

  it('limit mayor que 100 → error', async () => {
    const instance = plainToInstance(ListLowStockQueryDto, { limit: '500' });

    const errors = await validate(instance);

    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });

  it('categoryId/unitId inválidos (UUID) → error', async () => {
    const instance = plainToInstance(ListLowStockQueryDto, {
      categoryId: 'not-a-uuid',
      unitId: 'tampoco-un-uuid',
    });

    const errors = await validate(instance);

    expect(errors.some((error) => error.property === 'categoryId')).toBe(true);
    expect(errors.some((error) => error.property === 'unitId')).toBe(true);
  });

  it('payload vacío es válido', async () => {
    const instance = plainToInstance(ListLowStockQueryDto, {});

    const errors = await validate(instance);

    expect(errors).toHaveLength(0);
  });

  it('Fase 9 (R5): brand como string es válido a nivel de DTO (el trim/blanco se valida en el servicio)', async () => {
    const instance = plainToInstance(ListLowStockQueryDto, { brand: 'Bosch' });

    const errors = await validate(instance);

    expect(errors).toHaveLength(0);
  });

  it('Fase 9 (R5): status con enum real es válido', async () => {
    const instance = plainToInstance(ListLowStockQueryDto, {
      status: ProductStatus.INACTIVE,
    });

    const errors = await validate(instance);

    expect(errors).toHaveLength(0);
  });

  it('Fase 9 (R5): status inválido → error', async () => {
    const instance = plainToInstance(ListLowStockQueryDto, {
      status: 'NOT_A_STATUS',
    });

    const errors = await validate(instance);

    expect(errors.some((error) => error.property === 'status')).toBe(true);
  });
});

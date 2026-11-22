import { RoleName } from '@prisma/client';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import {
  CreateWarehouseDto,
  CreateWarehouseLocationDto,
  UpdateWarehouseDto,
} from './dto/warehouse-request.dto';
import { WarehousesController } from './warehouses.controller';
import { createValidationPipe } from '../common/pipes/validation.pipe';

const proto = WarehousesController.prototype as unknown as Record<
  string,
  object
>;

function rolesOf(method: string): RoleName[] {
  return Reflect.getMetadata(ROLES_KEY, proto[method]) as RoleName[];
}

const READ = [
  RoleName.ADMIN,
  RoleName.WAREHOUSE,
  RoleName.MANAGEMENT,
  RoleName.SELLER,
];

describe('WarehousesController — matriz de roles (R2-A1)', () => {
  it.each(['list', 'findOne', 'listLocations', 'findLocation'])(
    '%s: lectura para ADMIN, WAREHOUSE, MANAGEMENT y SELLER (nunca PURCHASING ni ACCOUNTANT)',
    (method) => {
      expect([...rolesOf(method)].sort()).toEqual([...READ].sort());
    },
  );

  it.each([
    'create',
    'update',
    'activate',
    'deactivate',
    'createLocation',
    'updateLocation',
    'activateLocation',
    'deactivateLocation',
  ])('%s: escritura exclusiva de ADMIN', (method) => {
    expect(rolesOf(method)).toEqual([RoleName.ADMIN]);
  });
});

describe('DTOs del catálogo', () => {
  const pipe = createValidationPipe();

  it('normaliza el código a mayúsculas sin espacios antes de validar', async () => {
    const dto = plainToInstance(CreateWarehouseDto, {
      code: '  sur-1 ',
      name: ' Sur ',
    });
    expect(dto.code).toBe('SUR-1');
    expect(await validate(dto)).toHaveLength(0);
  });

  it.each(['', 'A B', '-A', 'X'.repeat(21), 'ñ'])(
    'rechaza el código inválido %p',
    async (code) => {
      const dto = plainToInstance(CreateWarehouseDto, { code, name: 'x' });
      expect((await validate(dto)).length).toBeGreaterThan(0);
    },
  );

  it('el código de ubicación admite hasta 30 caracteres', async () => {
    const ok = plainToInstance(CreateWarehouseLocationDto, {
      code: 'a'.repeat(30),
      name: 'x',
    });
    expect(await validate(ok)).toHaveLength(0);
    const bad = plainToInstance(CreateWarehouseLocationDto, {
      code: 'a'.repeat(31),
      name: 'x',
    });
    expect((await validate(bad)).length).toBeGreaterThan(0);
  });

  it.each(['code', 'status', 'isDefault', 'id', 'warehouseId'])(
    'PATCH rechaza el campo inmutable %s (whitelist estricta -> 400)',
    async (field) => {
      await expect(
        pipe.transform(
          { name: 'ok', [field]: 'X' },
          { type: 'body', metatype: UpdateWarehouseDto },
        ),
      ).rejects.toBeDefined();
    },
  );

  it('PATCH acepta description null para limpiarla', async () => {
    await expect(
      pipe.transform(
        { description: null },
        { type: 'body', metatype: UpdateWarehouseDto },
      ),
    ).resolves.toMatchObject({ description: null });
  });
});

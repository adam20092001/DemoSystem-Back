import 'reflect-metadata';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { CreateStockTransferDto } from './dto/create-stock-transfer.dto';
import { ListStockTransfersQueryDto } from './dto/list-stock-transfers-query.dto';
import { StockTransfersController } from './stock-transfers.controller';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222221';
const DEST_ID = '22222222-2222-4222-8222-222222222222';

function strictPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
}

function valid(overrides: Record<string, unknown> = {}) {
  return {
    productId: PRODUCT_ID,
    sourceLocationId: SOURCE_ID,
    destinationLocationId: DEST_ID,
    quantity: '10.000',
    reason: 'Reposición de estante',
    ...overrides,
  };
}

const create = (body: Record<string, unknown>) =>
  strictPipe().transform(body, {
    type: 'body',
    metatype: CreateStockTransferDto,
  });

describe('CreateStockTransferDto', () => {
  it('acepta el cuerpo mínimo y el completo', async () => {
    await expect(create(valid())).resolves.toBeDefined();
    await expect(
      create(valid({ notes: 'obs', idempotencyKey: 'abc-1' })),
    ).resolves.toBeDefined();
  });

  it.each([
    ['productId', 'no-uuid'],
    ['sourceLocationId', 'no-uuid'],
    ['destinationLocationId', 'no-uuid'],
    ['quantity', '-1'],
    ['quantity', '1.2345'],
    ['quantity', '1e3'],
    ['quantity', 10],
    ['reason', ''],
    ['reason', 'x'.repeat(201)],
    ['notes', 'x'.repeat(501)],
    ['idempotencyKey', ''],
    ['idempotencyKey', 'k'.repeat(101)],
  ])('rechaza %s = %p', async (field, value) => {
    await expect(create(valid({ [field]: value }))).rejects.toThrow();
  });

  it.each([
    'productId',
    'sourceLocationId',
    'destinationLocationId',
    'quantity',
    'reason',
  ])('rechaza la falta de %s', async (field) => {
    const body = valid();
    delete (body as Record<string, unknown>)[field];
    await expect(create(body)).rejects.toThrow();
  });

  it.each([
    'origin',
    'movementType',
    'createdByUserId',
    'referenceType',
    'referenceId',
    'createdAt',
    'warehouseId',
  ])('rechaza el atributo no permitido %s', async (field) => {
    await expect(create(valid({ [field]: 'x' }))).rejects.toThrow();
  });
});

describe('ListStockTransfersQueryDto', () => {
  const list = (query: Record<string, unknown>) =>
    strictPipe().transform(query, {
      type: 'query',
      metatype: ListStockTransfersQueryDto,
    });

  it('acepta filtros válidos', async () => {
    await expect(
      list({
        page: '1',
        limit: '20',
        productId: PRODUCT_ID,
        warehouseId: SOURCE_ID,
        dateFrom: '2026-11-01',
        dateTo: '2026-11-30',
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    { productId: 'x' },
    { warehouseId: 'x' },
    { limit: '101' },
    { page: '0' },
    { dateFrom: 'ayer' },
    { desconocido: '1' },
  ])('rechaza %p', async (query) => {
    await expect(list(query)).rejects.toThrow();
  });
});

describe('StockTransfersController — rutas y permisos', () => {
  const proto = StockTransfersController.prototype as unknown as Record<
    string,
    object
  >;
  const roles = (name: string) =>
    Reflect.getMetadata(ROLES_KEY, proto[name]) as RoleName[];
  const method = (name: string) =>
    Reflect.getMetadata(METHOD_METADATA, proto[name]) as RequestMethod;

  it('POST: solo ADMIN y WAREHOUSE', () => {
    expect(method('create')).toBe(RequestMethod.POST);
    expect(roles('create')).toEqual([RoleName.ADMIN, RoleName.WAREHOUSE]);
  });

  it('GET listado y detalle: ADMIN, WAREHOUSE y MANAGEMENT', () => {
    const read = [RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT];
    expect(method('list')).toBe(RequestMethod.GET);
    expect(method('findOne')).toBe(RequestMethod.GET);
    expect(roles('list')).toEqual(read);
    expect(roles('findOne')).toEqual(read);
  });

  it('no existe ninguna ruta de anulación, edición ni borrado', () => {
    const names = Object.getOwnPropertyNames(
      StockTransfersController.prototype,
    ).filter((n) => n !== 'constructor' && !n.startsWith('to'));
    expect(names.sort()).toEqual(['create', 'findOne', 'list']);
  });
});

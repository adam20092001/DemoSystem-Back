import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryMovementOrigin,
  InventoryMovementType,
  Prisma,
  RoleName,
} from '@prisma/client';
import { AuditAction } from '../../audit/audit-action.enum';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../database/prisma.service';
import { StockMovementEngine } from '../stock-movement.engine';
import { StockTransfersService } from './stock-transfers.service';
import { CreateStockTransferInput } from './types/create-stock-transfer.input';

const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222221';
const DEST_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-23T12:00:00.000Z');

function makeTransferRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'transfer-1',
    product: { id: PRODUCT_ID, sku: 'SKU-1', name: 'Producto uno' },
    sourceLocation: {
      id: SOURCE_ID,
      code: 'DEFAULT',
      name: 'Origen',
      warehouse: { id: 'w1', code: 'MAIN' },
    },
    destinationLocation: {
      id: DEST_ID,
      code: 'ESTANTE-A',
      name: 'Destino',
      warehouse: { id: 'w1', code: 'MAIN' },
    },
    quantity: new Prisma.Decimal('10.000'),
    reason: 'Reposición',
    notes: null,
    idempotencyKey: null,
    createdBy: {
      id: ACTOR_ID,
      username: 'jdoe',
      firstName: 'Juan',
      lastName: 'Doe',
    },
    exitMovementId: 'exit-1',
    entryMovementId: 'entry-1',
    createdAt: NOW,
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<CreateStockTransferInput> = {},
): CreateStockTransferInput {
  return {
    productId: PRODUCT_ID,
    sourceLocationId: SOURCE_ID,
    destinationLocationId: DEST_ID,
    quantity: '10',
    reason: 'Reposición',
    requesterRole: RoleName.ADMIN,
    actorUserId: ACTOR_ID,
    ipAddress: '10.0.0.1',
    ...overrides,
  };
}

function createMocks() {
  const tx = {
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue([]),
    stockTransfer: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
      create: jest.fn<Promise<unknown>, [unknown]>(),
    },
  };
  const prisma = {
    $transaction: jest.fn((cb: (client: typeof tx) => unknown) => cb(tx)),
    stockTransfer: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      count: jest.fn<Promise<number>, [unknown]>(),
    },
  };
  const engine = {
    lockLocationsShared: jest.fn<Promise<string[]>, [unknown, string[]]>(
      (_tx, requested) => Promise.resolve(requested),
    ),
    apply: jest.fn<Promise<{ id: string }>, [unknown, unknown]>(),
  };
  const audit = { record: jest.fn<Promise<void>, [Record<string, unknown>]>() };
  return { tx, prisma, engine, audit };
}

describe('StockTransfersService', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: StockTransfersService;

  beforeEach(() => {
    mocks = createMocks();
    mocks.engine.apply
      .mockResolvedValueOnce({ id: 'exit-1' })
      .mockResolvedValueOnce({ id: 'entry-1' });
    mocks.audit.record.mockResolvedValue(undefined);
    mocks.tx.stockTransfer.create.mockResolvedValue(makeTransferRow());
    service = new StockTransfersService(
      mocks.prisma as unknown as PrismaService,
      mocks.audit as unknown as AuditService,
      mocks.engine as unknown as StockMovementEngine,
    );
  });

  describe('create — flujo y bloqueos', () => {
    it('bloquea origen y destino JUNTOS antes del primer movimiento y aplica EXIT(origen) -> ENTRY(destino) con origin=TRANSFER', async () => {
      const result = await service.create(makeInput());

      expect(mocks.engine.lockLocationsShared).toHaveBeenCalledTimes(1);
      expect(mocks.engine.lockLocationsShared.mock.calls[0][1]).toEqual([
        SOURCE_ID,
        DEST_ID,
      ]);
      expect(
        mocks.engine.lockLocationsShared.mock.invocationCallOrder[0],
      ).toBeLessThan(mocks.engine.apply.mock.invocationCallOrder[0]);

      const [exitCall, entryCall] = mocks.engine.apply.mock.calls.map(
        (c) => c[1] as Record<string, unknown>,
      );
      expect(exitCall).toMatchObject({
        productId: PRODUCT_ID,
        movementType: InventoryMovementType.EXIT,
        origin: InventoryMovementOrigin.TRANSFER,
        locationId: SOURCE_ID,
        referenceType: 'StockTransfer',
        actorUserId: ACTOR_ID,
      });
      expect(entryCall).toMatchObject({
        movementType: InventoryMovementType.ENTRY,
        origin: InventoryMovementOrigin.TRANSFER,
        locationId: DEST_ID,
        referenceType: 'StockTransfer',
      });
      // Ambos movimientos comparten el id del documento.
      expect(exitCall.referenceId).toBe(entryCall.referenceId);
      expect((exitCall.quantity as Prisma.Decimal).toFixed(3)).toBe('10.000');
      expect(result.id).toBe('transfer-1');
      expect(result.quantity).toBe('10.000');
    });

    it('persiste el documento con el MISMO id de referencia y los ids de ambos movimientos', async () => {
      await service.create(makeInput());
      const exitCall = mocks.engine.apply.mock.calls[0][1] as {
        referenceId: string;
      };
      const createArgs = mocks.tx.stockTransfer.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createArgs.data.id).toBe(exitCall.referenceId);
      expect(createArgs.data.exitMovementId).toBe('exit-1');
      expect(createArgs.data.entryMovementId).toBe('entry-1');
      expect(createArgs.data.createdByUserId).toBe(ACTOR_ID);
    });

    it('audita INVENTORY_TRANSFER_CREATED en la misma transacción', async () => {
      await service.create(makeInput());
      const call = mocks.audit.record.mock.calls[0][0];
      expect(call.action).toBe(AuditAction.INVENTORY_TRANSFER_CREATED);
      expect(call.entityType).toBe('StockTransfer');
      expect(call.client).toBe(mocks.tx);
      expect(call.metadata).toMatchObject({
        productId: PRODUCT_ID,
        quantity: '10.000',
        sourceLocationId: SOURCE_ID,
        destinationLocationId: DEST_ID,
        exitMovementId: 'exit-1',
        entryMovementId: 'entry-1',
      });
    });

    it('todo ocurre en UNA transacción y nunca consulta valorización ni contabilidad', async () => {
      await service.create(makeInput());
      expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
      // El servicio solo recibe prisma, auditoría y el motor de stock.
      expect(service['prisma']).toBeDefined();
      expect(Object.keys(service as unknown as object).sort()).toEqual([
        'auditService',
        'engine',
        'prisma',
      ]);
    });

    it('si el ENTRY falla propaga el error (la transacción revierte el EXIT) y no crea el documento ni audita', async () => {
      mocks.engine.apply.mockReset();
      mocks.engine.apply
        .mockResolvedValueOnce({ id: 'exit-1' })
        .mockRejectedValueOnce(new ConflictException('destino inactivo'));
      await expect(service.create(makeInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mocks.tx.stockTransfer.create).not.toHaveBeenCalled();
      expect(mocks.audit.record).not.toHaveBeenCalled();
    });

    it('si el motor rechaza una ubicación (404/409) no se mueve stock ni se crea nada', async () => {
      mocks.engine.lockLocationsShared.mockRejectedValueOnce(
        new NotFoundException('Ubicación no encontrada'),
      );
      await expect(service.create(makeInput())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.engine.apply).not.toHaveBeenCalled();
      expect(mocks.tx.stockTransfer.create).not.toHaveBeenCalled();
    });

    it('stock insuficiente en el origen (409 del motor) se propaga sin tocar el destino', async () => {
      mocks.engine.apply.mockReset();
      mocks.engine.apply.mockRejectedValueOnce(
        new ConflictException(
          'Stock insuficiente para completar el movimiento',
        ),
      );
      await expect(service.create(makeInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mocks.engine.apply).toHaveBeenCalledTimes(1);
    });
  });

  describe('create — validaciones previas (sin abrir transacción)', () => {
    it.each([
      ['origen igual a destino', { destinationLocationId: SOURCE_ID }],
      [
        'origen igual a destino con distinta capitalización',
        { destinationLocationId: SOURCE_ID.toUpperCase() },
      ],
      ['cantidad cero', { quantity: '0' }],
      ['cantidad cero con decimales', { quantity: '0.000' }],
      ['cantidad negativa', { quantity: '-1' }],
      ['más de 3 decimales', { quantity: '1.2345' }],
      ['cantidad no numérica', { quantity: 'abc' }],
      ['motivo vacío tras trim', { reason: '   ' }],
      ['motivo de más de 200 caracteres', { reason: 'x'.repeat(201) }],
      ['notas de más de 500 caracteres', { notes: 'x'.repeat(501) }],
      ['clave de idempotencia vacía', { idempotencyKey: '   ' }],
      [
        'clave de idempotencia de más de 100 caracteres',
        { idempotencyKey: 'k'.repeat(101) },
      ],
    ])('%s → 400', async (_name, overrides) => {
      await expect(
        service.create(
          makeInput(overrides as Partial<CreateStockTransferInput>),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      RoleName.SELLER,
      RoleName.MANAGEMENT,
      RoleName.PURCHASING,
      RoleName.ACCOUNTANT,
    ])('el rol %s no puede crear (403) y no abre transacción', async (role) => {
      await expect(
        service.create(makeInput({ requesterRole: role })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([RoleName.ADMIN, RoleName.WAREHOUSE])(
      'el rol %s sí puede crear',
      async (role) => {
        await expect(
          service.create(makeInput({ requesterRole: role })),
        ).resolves.toBeDefined();
      },
    );
  });

  describe('create — idempotencia', () => {
    const KEY = 'transfer-key-1';

    it('sin clave: no toma bloqueo advisory ni busca duplicados', async () => {
      await service.create(makeInput());
      expect(mocks.tx.$queryRaw).not.toHaveBeenCalled();
      expect(mocks.tx.stockTransfer.findUnique).not.toHaveBeenCalled();
    });

    it('con clave: toma el bloqueo advisory ANTES de buscar y de bloquear ubicaciones', async () => {
      mocks.tx.stockTransfer.findUnique.mockResolvedValue(null);
      await service.create(makeInput({ idempotencyKey: KEY }));
      expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(mocks.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.tx.stockTransfer.findUnique.mock.invocationCallOrder[0],
      );
      expect(
        mocks.tx.stockTransfer.findUnique.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mocks.engine.lockLocationsShared.mock.invocationCallOrder[0],
      );
      const createArgs = mocks.tx.stockTransfer.create.mock.calls[0][0] as {
        data: { idempotencyKey: string };
      };
      expect(createArgs.data.idempotencyKey).toBe(KEY);
    });

    it('misma clave y mismo contenido: devuelve la ORIGINAL sin mover stock, crear ni auditar', async () => {
      mocks.tx.stockTransfer.findUnique.mockResolvedValue(
        makeTransferRow({ idempotencyKey: KEY }),
      );
      const result = await service.create(makeInput({ idempotencyKey: KEY }));
      expect(result.id).toBe('transfer-1');
      expect(mocks.engine.lockLocationsShared).not.toHaveBeenCalled();
      expect(mocks.engine.apply).not.toHaveBeenCalled();
      expect(mocks.tx.stockTransfer.create).not.toHaveBeenCalled();
      expect(mocks.audit.record).not.toHaveBeenCalled();
    });

    it('el contenido se compara en forma canónica (cantidad 10 == 10.000, textos recortados, UUID en mayúsculas)', async () => {
      mocks.tx.stockTransfer.findUnique.mockResolvedValue(
        makeTransferRow({ idempotencyKey: KEY }),
      );
      await expect(
        service.create(
          makeInput({
            idempotencyKey: KEY,
            quantity: '10.000',
            reason: '  Reposición  ',
            productId: PRODUCT_ID.toUpperCase(),
            notes: '   ',
          }),
        ),
      ).resolves.toBeDefined();
    });

    it.each([
      ['cantidad', { quantity: '11' }],
      ['producto', { productId: '99999999-9999-4999-8999-999999999999' }],
      ['origen', { sourceLocationId: '99999999-9999-4999-8999-999999999999' }],
      [
        'destino',
        { destinationLocationId: '99999999-9999-4999-8999-999999999999' },
      ],
      ['motivo', { reason: 'Otro motivo' }],
      ['notas', { notes: 'Con notas' }],
    ])(
      'misma clave con %s distinto → 409 sin mover stock',
      async (_name, overrides) => {
        mocks.tx.stockTransfer.findUnique.mockResolvedValue(
          makeTransferRow({ idempotencyKey: KEY }),
        );
        await expect(
          service.create(
            makeInput({
              idempotencyKey: KEY,
              ...(overrides as Partial<CreateStockTransferInput>),
            }),
          ),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(mocks.engine.apply).not.toHaveBeenCalled();
      },
    );
  });

  describe('consultas', () => {
    it('findOne: 404 si no existe', async () => {
      mocks.prisma.stockTransfer.findUnique.mockResolvedValue(null);
      await expect(service.findOne('x', RoleName.ADMIN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it.each([RoleName.SELLER, RoleName.PURCHASING, RoleName.ACCOUNTANT])(
      'findOne/list: el rol %s recibe 403',
      async (role) => {
        await expect(service.findOne('x', role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(service.list({}, role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      },
    );

    it.each([RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT])(
      'el rol %s puede consultar',
      async (role) => {
        mocks.prisma.stockTransfer.findUnique.mockResolvedValue(
          makeTransferRow(),
        );
        mocks.prisma.stockTransfer.findMany.mockResolvedValue([]);
        mocks.prisma.stockTransfer.count.mockResolvedValue(0);
        await expect(service.findOne('x', role)).resolves.toBeDefined();
        await expect(service.list({}, role)).resolves.toMatchObject({
          total: 0,
        });
      },
    );

    it('list: filtros combinados con AND, almacén = origen O destino, orden fijo y paginación', async () => {
      mocks.prisma.stockTransfer.findMany.mockResolvedValue([
        makeTransferRow(),
      ]);
      mocks.prisma.stockTransfer.count.mockResolvedValue(41);
      const result = await service.list(
        {
          page: 2,
          limit: 20,
          productId: PRODUCT_ID,
          sourceLocationId: SOURCE_ID,
          destinationLocationId: DEST_ID,
          warehouseId: 'w1',
          dateFrom: new Date('2026-11-01T00:00:00Z'),
          dateTo: new Date('2026-11-30T00:00:00Z'),
        },
        RoleName.ADMIN,
      );
      const args = mocks.prisma.stockTransfer.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        orderBy: unknown;
        skip: number;
        take: number;
      };
      expect(args.where).toMatchObject({
        productId: PRODUCT_ID,
        sourceLocationId: SOURCE_ID,
        destinationLocationId: DEST_ID,
        OR: [
          { sourceLocation: { warehouseId: 'w1' } },
          { destinationLocation: { warehouseId: 'w1' } },
        ],
      });
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.skip).toBe(20);
      expect(args.take).toBe(20);
      expect(result).toMatchObject({
        page: 2,
        limit: 20,
        total: 41,
        totalPages: 3,
      });
      expect(result.data[0].quantity).toBe('10.000');
    });

    it('list: dateFrom mayor que dateTo → 400', async () => {
      await expect(
        service.list(
          {
            dateFrom: new Date('2026-12-01T00:00:00Z'),
            dateTo: new Date('2026-11-01T00:00:00Z'),
          },
          RoleName.ADMIN,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

import { BadRequestException } from '@nestjs/common';
import {
  Prisma,
  RoleName,
  SalePaymentStatus,
  SaleStatus,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AccountsReceivableService } from './accounts-receivable.service';

function makeReceivableRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sale-1',
    number: 'NV-000001',
    customerId: 'customer-1',
    customerName: 'Cliente Uno',
    customerDocumentNumber: '12345678',
    sellerId: 'seller-1',
    confirmedAt: new Date(),
    total: new Prisma.Decimal('100.00'),
    paidAmount: new Prisma.Decimal('40.00'),
    balanceDue: new Prisma.Decimal('60.00'),
    paymentStatus: SalePaymentStatus.PARTIALLY_PAID,
    ...overrides,
  };
}

function createPrismaMock() {
  return {
    sale: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
      count: jest.fn<Promise<number>, [Record<string, unknown>]>(),
    },
  };
}

describe('AccountsReceivableService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: AccountsReceivableService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.sale.findMany.mockResolvedValue([makeReceivableRow()]);
    prisma.sale.count.mockResolvedValue(1);
    service = new AccountsReceivableService(prisma as unknown as PrismaService);
  });

  describe('definición fija de cuenta por cobrar', () => {
    it('siempre filtra status=ACTIVE y balanceDue>0, sin importar los filtros del llamador', async () => {
      await service.list({}, RoleName.ADMIN);
      const call = prisma.sale.findMany.mock.calls[0][0] as {
        where: { AND: Record<string, unknown>[] };
      };
      expect(call.where.AND).toEqual(
        expect.arrayContaining([
          { status: SaleStatus.ACTIVE },
          { balanceDue: { gt: 0 } },
        ]),
      );
    });

    it('no agrega un filtro especial para el cliente genérico (la invariante de BD ya lo excluye)', async () => {
      await service.list({}, RoleName.ADMIN);
      const call = prisma.sale.findMany.mock.calls[0][0] as {
        where: { AND: Record<string, unknown>[] };
      };
      const serialized = JSON.stringify(call.where);
      expect(serialized).not.toMatch(/generic/i);
    });

    it('no excluye clientes BLOCKED (ningún filtro sobre Customer.status)', async () => {
      await service.list({}, RoleName.ADMIN);
      const call = prisma.sale.findMany.mock.calls[0][0] as {
        where: { AND: Record<string, unknown>[] };
      };
      const serialized = JSON.stringify(call.where);
      expect(serialized).not.toMatch(/blocked/i);
      expect(serialized).not.toMatch(/customer.{0,3}status/i);
    });
  });

  describe('filtros', () => {
    it('customerId/sellerId se incluyen en el where', async () => {
      await service.list(
        { customerId: 'customer-1', sellerId: 'seller-1' },
        RoleName.ADMIN,
      );
      const call = prisma.sale.findMany.mock.calls[0][0] as {
        where: { AND: Record<string, unknown>[] };
      };
      expect(call.where.AND).toEqual(
        expect.arrayContaining([
          { customerId: 'customer-1' },
          { sellerId: 'seller-1' },
        ]),
      );
    });

    it('confirmedFrom/confirmedTo inválidos -> 400', async () => {
      await expect(
        service.list({ confirmedFrom: 'no-es-fecha' }, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('confirmedFrom > confirmedTo -> 400', async () => {
      await expect(
        service.list(
          { confirmedFrom: '2026-03-20', confirmedTo: '2026-03-10' },
          RoleName.ADMIN,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('orden y paginación', () => {
    it('orden confirmedAt asc, id asc (deuda más antigua primero)', async () => {
      await service.list({}, RoleName.ADMIN);
      const call = prisma.sale.findMany.mock.calls[0][0] as {
        orderBy: unknown;
      };
      expect(call.orderBy).toEqual([{ confirmedAt: 'asc' }, { id: 'asc' }]);
    });

    it('findMany y count usan el mismo where', async () => {
      await service.list({ customerId: 'customer-1' }, RoleName.ADMIN);
      const findManyWhere = (
        prisma.sale.findMany.mock.calls[0][0] as { where: unknown }
      ).where;
      const countWhere = (
        prisma.sale.count.mock.calls[0][0] as { where: unknown }
      ).where;
      expect(findManyWhere).toEqual(countWhere);
    });

    it('limit por defecto 20, máximo 100', async () => {
      const defaultResult = await service.list({}, RoleName.ADMIN);
      expect(defaultResult.limit).toBe(20);

      const cappedResult = await service.list({ limit: 500 }, RoleName.ADMIN);
      expect(cappedResult.limit).toBe(100);
    });

    it('sin resultados: totalPages=0', async () => {
      prisma.sale.findMany.mockResolvedValue([]);
      prisma.sale.count.mockResolvedValue(0);
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.totalPages).toBe(0);
    });
  });

  describe('mapeo de fila segura', () => {
    it('montos como string de 2 decimales; daysOutstanding calculado', async () => {
      const confirmedAt = new Date();
      prisma.sale.findMany.mockResolvedValue([
        makeReceivableRow({ confirmedAt }),
      ]);
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.data[0].total).toBe('100.00');
      expect(result.data[0].paidAmount).toBe('40.00');
      expect(result.data[0].balanceDue).toBe('60.00');
      expect(result.data[0].daysOutstanding).toBe(0);
      expect(result.data[0].daysOutstanding).toBeGreaterThanOrEqual(0);
    });

    it('nunca expone Customer.status, notas internas, referencia de Payment ni filas de Payment', async () => {
      const result = await service.list({}, RoleName.ADMIN);
      const serialized = JSON.stringify(result.data[0]);
      expect(serialized).not.toMatch(/status.*customer|customerStatus/i);
      expect(serialized).not.toMatch(/internalNotes/i);
      expect(serialized).not.toMatch(/reference/i);
      expect(serialized).not.toMatch(/"payments"|paymentId|paymentMethod/i);
    });
  });

  describe('defensa de lectura (fail-closed)', () => {
    it('ADMIN/SELLER/MANAGEMENT: consultan normalmente', async () => {
      for (const role of [
        RoleName.ADMIN,
        RoleName.SELLER,
        RoleName.MANAGEMENT,
      ]) {
        prisma.sale.findMany.mockClear();
        await service.list({}, role);
        expect(prisma.sale.findMany).toHaveBeenCalled();
      }
    });

    it('WAREHOUSE: página vacía sin ejecutar Sale findMany/count', async () => {
      const result = await service.list({}, RoleName.WAREHOUSE);
      expect(result).toEqual({
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
      expect(prisma.sale.findMany).not.toHaveBeenCalled();
      expect(prisma.sale.count).not.toHaveBeenCalled();
    });

    it('rol desconocido: página vacía sin ejecutar Sale findMany/count', async () => {
      const result = await service.list({}, 'UNKNOWN' as RoleName);
      expect(result.data).toEqual([]);
      expect(prisma.sale.findMany).not.toHaveBeenCalled();
      expect(prisma.sale.count).not.toHaveBeenCalled();
    });

    it('sin restricción de propiedad para SELLER: sin sellerId en la query, el where no agrega ningún filtro de vendedor', async () => {
      await service.list({}, RoleName.SELLER);
      const call = prisma.sale.findMany.mock.calls[0][0] as {
        where: { AND: Record<string, unknown>[] };
      };
      expect(call.where.AND.some((condition) => 'sellerId' in condition)).toBe(
        false,
      );
    });
  });
});

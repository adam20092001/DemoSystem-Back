import { BadRequestException } from '@nestjs/common';
import {
  Prisma,
  RoleName,
  SalePaymentStatus,
  SaleStatus,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { SaleAccessRequester } from '../sales/sale-access.policy';
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

const REQUESTER_ID = 'requester-1';
// Permisos por vendedor (P5): solicitante = usuario autenticado (id + rol activo).
function asRole(
  role: RoleName,
  id: string = REQUESTER_ID,
): SaleAccessRequester {
  return { id, role };
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
      await service.list({}, asRole(RoleName.ADMIN));
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
      await service.list({}, asRole(RoleName.ADMIN));
      const call = prisma.sale.findMany.mock.calls[0][0] as {
        where: { AND: Record<string, unknown>[] };
      };
      const serialized = JSON.stringify(call.where);
      expect(serialized).not.toMatch(/generic/i);
    });

    it('no excluye clientes BLOCKED (ningún filtro sobre Customer.status)', async () => {
      await service.list({}, asRole(RoleName.ADMIN));
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
        asRole(RoleName.ADMIN),
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
        service.list({ confirmedFrom: 'no-es-fecha' }, asRole(RoleName.ADMIN)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('confirmedFrom > confirmedTo -> 400', async () => {
      await expect(
        service.list(
          { confirmedFrom: '2026-03-20', confirmedTo: '2026-03-10' },
          asRole(RoleName.ADMIN),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('orden y paginación', () => {
    it('orden confirmedAt asc, id asc (deuda más antigua primero)', async () => {
      await service.list({}, asRole(RoleName.ADMIN));
      const call = prisma.sale.findMany.mock.calls[0][0] as {
        orderBy: unknown;
      };
      expect(call.orderBy).toEqual([{ confirmedAt: 'asc' }, { id: 'asc' }]);
    });

    it('findMany y count usan el mismo where', async () => {
      await service.list({ customerId: 'customer-1' }, asRole(RoleName.ADMIN));
      const findManyWhere = (
        prisma.sale.findMany.mock.calls[0][0] as { where: unknown }
      ).where;
      const countWhere = (
        prisma.sale.count.mock.calls[0][0] as { where: unknown }
      ).where;
      expect(findManyWhere).toEqual(countWhere);
    });

    it('limit por defecto 20, máximo 100', async () => {
      const defaultResult = await service.list({}, asRole(RoleName.ADMIN));
      expect(defaultResult.limit).toBe(20);

      const cappedResult = await service.list(
        { limit: 500 },
        asRole(RoleName.ADMIN),
      );
      expect(cappedResult.limit).toBe(100);
    });

    it('sin resultados: totalPages=0', async () => {
      prisma.sale.findMany.mockResolvedValue([]);
      prisma.sale.count.mockResolvedValue(0);
      const result = await service.list({}, asRole(RoleName.ADMIN));
      expect(result.totalPages).toBe(0);
    });
  });

  describe('mapeo de fila segura', () => {
    it('montos como string de 2 decimales; daysOutstanding calculado', async () => {
      const confirmedAt = new Date();
      prisma.sale.findMany.mockResolvedValue([
        makeReceivableRow({ confirmedAt }),
      ]);
      const result = await service.list({}, asRole(RoleName.ADMIN));
      expect(result.data[0].total).toBe('100.00');
      expect(result.data[0].paidAmount).toBe('40.00');
      expect(result.data[0].balanceDue).toBe('60.00');
      expect(result.data[0].daysOutstanding).toBe(0);
      expect(result.data[0].daysOutstanding).toBeGreaterThanOrEqual(0);
    });

    it('nunca expone Customer.status, notas internas, referencia de Payment ni filas de Payment', async () => {
      const result = await service.list({}, asRole(RoleName.ADMIN));
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
        await service.list({}, asRole(role));
        expect(prisma.sale.findMany).toHaveBeenCalled();
      }
    });

    it('WAREHOUSE: página vacía sin ejecutar Sale findMany/count', async () => {
      const result = await service.list({}, asRole(RoleName.WAREHOUSE));
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
      const result = await service.list({}, asRole('UNKNOWN' as RoleName));
      expect(result.data).toEqual([]);
      expect(prisma.sale.findMany).not.toHaveBeenCalled();
      expect(prisma.sale.count).not.toHaveBeenCalled();
    });

    it('SELLER: restringido a sus ventas aunque no envíe sellerId (P5)', async () => {
      await service.list({}, asRole(RoleName.SELLER));
      const call = prisma.sale.findMany.mock.calls[0][0] as {
        where: { AND: unknown[] };
      };
      expect(call.where.AND[0]).toEqual({ sellerId: REQUESTER_ID });
    });
  });

  describe('permisos por vendedor (P5)', () => {
    const OWN_SELLER_ID = 'seller-own';
    const OTHER_SELLER_ID = 'seller-other';
    const seller = asRole(RoleName.SELLER, OWN_SELLER_ID);

    function whereOf(call: 'findMany' | 'count'): {
      AND: Record<string, unknown>[];
    } {
      return (
        prisma.sale[call].mock.calls[0][0] as {
          where: { AND: Record<string, unknown>[] };
        }
      ).where;
    }

    it('SELLER: alcance sellerId = actor AND definición fija de cuenta por cobrar', async () => {
      await service.list({}, seller);
      const where = whereOf('findMany');
      expect(where.AND[0]).toEqual({ sellerId: OWN_SELLER_ID });
      expect(where.AND[1]).toEqual({
        AND: [{ status: 'ACTIVE' }, { balanceDue: { gt: 0 } }],
      });
    });

    it('SELLER con sellerId de otro vendedor: condición insatisfacible (AND), nunca amplía', async () => {
      await service.list({ sellerId: OTHER_SELLER_ID }, seller);
      const where = whereOf('findMany');
      expect(where.AND[0]).toEqual({ sellerId: OWN_SELLER_ID });
      expect(
        (where.AND[1] as { AND: Record<string, unknown>[] }).AND,
      ).toContainEqual({ sellerId: OTHER_SELLER_ID });
    });

    it('findMany y count usan el mismo where restringido', async () => {
      await service.list(
        { sellerId: OTHER_SELLER_ID, customerId: 'customer-1' },
        seller,
      );
      expect(whereOf('count')).toEqual(whereOf('findMany'));
    });

    it('ADMIN y MANAGEMENT conservan la consulta completa (sin condición de vendedor obligatoria)', async () => {
      for (const role of [RoleName.ADMIN, RoleName.MANAGEMENT]) {
        prisma.sale.findMany.mockClear();
        await service.list({}, asRole(role, OWN_SELLER_ID));
        const where = whereOf('findMany');
        expect(where.AND.some((c) => 'sellerId' in c)).toBe(false);
      }
    });
  });
});

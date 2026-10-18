import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PaymentStatus, Prisma, RoleName, SaleStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PaymentEngine } from './payment.engine';
import { SaleAccessRequester } from '../sales/sale-access.policy';
import { PaymentsService } from './payments.service';
import {
  CancelPaymentInput,
  RegisterPaymentInput,
} from './types/payment.input';

const SALE_ID = 'sale-1';
const PAYMENT_ID = 'payment-1';
const ACTOR_ID = 'actor-1';
// Permisos por vendedor (P5): solicitante = usuario autenticado (id + rol activo).
function asRole(role: RoleName, id: string = ACTOR_ID): SaleAccessRequester {
  return { id, role };
}

function makeSaleLockRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SALE_ID,
    number: 'NV-000001',
    status: SaleStatus.ACTIVE,
    // P4: el SELECT ... FOR UPDATE incluye seller_id (dueño comercial).
    sellerId: ACTOR_ID,
    total: new Prisma.Decimal('100.00'),
    customerIsGeneric: false,
    ...overrides,
  };
}

function makePaymentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PAYMENT_ID,
    saleId: SALE_ID,
    paymentMethodCode: 'CASH',
    paymentMethodName: 'Efectivo',
    amount: new Prisma.Decimal('40.00'),
    reference: null,
    status: PaymentStatus.ACTIVE,
    paidAt: new Date('2026-03-15T12:00:00.000Z'),
    createdBy: {
      id: ACTOR_ID,
      username: 'admin',
      firstName: 'Ana',
      lastName: 'Admin',
    },
    cancelledAt: null,
    cancellationReason: null,
    cancellationSource: null,
    cancelledBy: null,
    createdAt: new Date('2026-03-15T12:00:00.000Z'),
    updatedAt: new Date('2026-03-15T12:00:00.000Z'),
    ...overrides,
  };
}

function createTxMock() {
  return {
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>(),
  };
}

function createPrismaMock() {
  const tx = createTxMock();
  return {
    tx,
    payment: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
      count: jest.fn<Promise<number>, [Record<string, unknown>]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createPaymentEngineMock() {
  return {
    register: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    sumActiveForSale: jest.fn<Promise<Prisma.Decimal>, [unknown, string]>(),
    recalculateSaleSummary: jest.fn<
      Promise<unknown>,
      [unknown, string, Prisma.Decimal]
    >(),
    cancel: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    cancelAllActiveForSale: jest.fn<Promise<unknown[]>, [unknown, unknown]>(),
  };
}

describe('PaymentsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let engine: ReturnType<typeof createPaymentEngineMock>;
  let service: PaymentsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    engine = createPaymentEngineMock();
    engine.register.mockResolvedValue(makePaymentRow());
    engine.sumActiveForSale.mockResolvedValue(new Prisma.Decimal(0));
    engine.recalculateSaleSummary.mockResolvedValue({
      paymentStatus: 'UNPAID',
      paidAmount: new Prisma.Decimal(0),
      balanceDue: new Prisma.Decimal('100.00'),
    });
    engine.cancel.mockResolvedValue(
      makePaymentRow({ status: PaymentStatus.CANCELLED }),
    );

    service = new PaymentsService(
      prisma as unknown as PrismaService,
      engine as unknown as PaymentEngine,
    );

    prisma.tx.$queryRaw.mockResolvedValue([makeSaleLockRow()]);
    prisma.payment.findMany.mockResolvedValue([makePaymentRow()]);
    prisma.payment.count.mockResolvedValue(1);
  });

  // ADMIN por defecto: sin restricción de propiedad (comportamiento previo).
  const validRegisterInput: RegisterPaymentInput & { actorRole: RoleName } = {
    saleId: SALE_ID,
    method: 'CASH',
    amount: '40.00',
    actorUserId: ACTOR_ID,
    actorRole: RoleName.ADMIN,
    ipAddress: '10.0.0.1',
  };

  const validCancelInput: CancelPaymentInput = {
    saleId: SALE_ID,
    paymentId: PAYMENT_ID,
    reason: 'Motivo de anulación',
    actorUserId: ACTOR_ID,
    ipAddress: '10.0.0.1',
  };

  // ====================================================================
  // register (pago posterior)
  // ====================================================================
  describe('register', () => {
    it('bloquea la venta con FOR UPDATE antes de cualquier otra operación', async () => {
      await service.register(validRegisterInput);
      const sql = (
        prisma.tx.$queryRaw.mock.calls[0][0] as Prisma.Sql
      ).strings.join(' ');
      expect(sql).toContain('FOR UPDATE');
      expect(sql).toContain('FROM sales');
    });

    it('monto malformado -> 400, sin abrir transacción', async () => {
      await expect(
        service.register({ ...validRegisterInput, amount: '-10.00' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('venta inexistente -> 404', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([]);
      await expect(service.register(validRegisterInput)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('venta CANCELLED -> 409', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeSaleLockRow({ status: SaleStatus.CANCELLED }),
      ]);
      await expect(service.register(validRegisterInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(engine.register).not.toHaveBeenCalled();
    });

    it('nunca consulta Customer (elegibilidad depende solo de Sale.status)', async () => {
      await service.register(validRegisterInput);
      expect(
        (prisma.tx as unknown as { customer?: unknown }).customer,
      ).toBeUndefined();
    });

    describe('cálculo de saldo en vivo', () => {
      it('monto menor al saldo: permitido', async () => {
        engine.sumActiveForSale.mockResolvedValue(new Prisma.Decimal('20.00'));
        await expect(
          service.register({ ...validRegisterInput, amount: '40.00' }),
        ).resolves.toBeDefined();
      });

      it('monto exactamente igual al saldo: permitido', async () => {
        engine.sumActiveForSale.mockResolvedValue(new Prisma.Decimal('60.00'));
        await expect(
          service.register({ ...validRegisterInput, amount: '40.00' }),
        ).resolves.toBeDefined();
      });

      it('monto mayor al saldo -> 409 (nunca 400)', async () => {
        engine.sumActiveForSale.mockResolvedValue(new Prisma.Decimal('80.00'));
        await expect(
          service.register({ ...validRegisterInput, amount: '40.00' }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(engine.register).not.toHaveBeenCalled();
      });

      it('saldo cero: cualquier pago positivo -> 409', async () => {
        engine.sumActiveForSale.mockResolvedValue(new Prisma.Decimal('100.00'));
        await expect(
          service.register({ ...validRegisterInput, amount: '0.01' }),
        ).rejects.toBeInstanceOf(ConflictException);
      });
    });

    it('delega en PaymentEngine.register con el mismo tx y luego recalcula el resumen', async () => {
      await service.register(validRegisterInput);
      expect(engine.register).toHaveBeenCalledWith(
        prisma.tx,
        expect.objectContaining({
          saleId: SALE_ID,
          saleNumber: 'NV-000001',
          method: 'CASH',
          actorUserId: ACTOR_ID,
        }),
      );
      expect(engine.recalculateSaleSummary).toHaveBeenCalledWith(
        prisma.tx,
        SALE_ID,
        expect.anything(),
      );
    });

    it('retorna { payment, sale } (nunca SafeSale completa)', async () => {
      const result = await service.register(validRegisterInput);
      expect(result).toHaveProperty('payment');
      expect(result).toHaveProperty('sale');
      expect(Object.keys(result).sort()).toEqual(['payment', 'sale']);
      expect(Object.keys(result.sale).sort()).toEqual(
        [
          'balanceDue',
          'id',
          'number',
          'paidAmount',
          'paymentStatus',
          'status',
          'total',
        ].sort(),
      );
    });

    describe('permisos por vendedor (P4)', () => {
      const OTHER_SELLER_ID = 'seller-other';

      function sellerInput(actorUserId: string) {
        return {
          ...validRegisterInput,
          actorUserId,
          actorRole: RoleName.SELLER,
        };
      }

      async function expectSaleNotFound(promise: Promise<unknown>) {
        const error = await promise.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).message).toBe('La venta no existe');
      }

      function expectNoPaymentEffects() {
        expect(engine.sumActiveForSale).not.toHaveBeenCalled();
        expect(engine.register).not.toHaveBeenCalled();
        expect(engine.recalculateSaleSummary).not.toHaveBeenCalled();
      }

      it('SELLER cobra su propia venta (sellerId de la fila bloqueada = actor)', async () => {
        await expect(
          service.register(sellerInput(ACTOR_ID)),
        ).resolves.toBeDefined();
        expect(engine.register).toHaveBeenCalledWith(
          prisma.tx,
          expect.objectContaining({ actorUserId: ACTOR_ID }),
        );
      });

      it('SELLER sobre una venta ajena: 404 "La venta no existe" sin saldo, Payment, contabilidad ni resumen', async () => {
        await expectSaleNotFound(
          service.register(sellerInput(OTHER_SELLER_ID)),
        );
        expectNoPaymentEffects();
      });

      it('venta inexistente: exactamente el mismo 404', async () => {
        prisma.tx.$queryRaw.mockResolvedValue([]);
        await expectSaleNotFound(
          service.register(sellerInput(OTHER_SELLER_ID)),
        );
        expectNoPaymentEffects();
      });

      it.each([
        ['anulada', { status: SaleStatus.CANCELLED }],
        ['de Público general', { customerIsGeneric: true }],
      ])(
        'venta ajena %s: sigue siendo 404 (nunca 409), sin revelar su estado',
        async (_label, overrides) => {
          prisma.tx.$queryRaw.mockResolvedValue([makeSaleLockRow(overrides)]);
          await expectSaleNotFound(
            service.register(sellerInput(OTHER_SELLER_ID)),
          );
          expectNoPaymentEffects();
        },
      );

      it('venta ajena totalmente pagada: 404 (nunca el 409 de saldo), sin consultar el saldo', async () => {
        engine.sumActiveForSale.mockResolvedValue(new Prisma.Decimal('100.00'));
        await expectSaleNotFound(
          service.register(sellerInput(OTHER_SELLER_ID)),
        );
        expectNoPaymentEffects();
      });

      it('la propiedad se decide con seller_id de la fila bloqueada (FOR UPDATE) y antes de cualquier otra consulta', async () => {
        await expectSaleNotFound(
          service.register(sellerInput(OTHER_SELLER_ID)),
        );
        expect(prisma.tx.$queryRaw).toHaveBeenCalledTimes(1);
        const sql = (
          prisma.tx.$queryRaw.mock.calls[0][0] as Prisma.Sql
        ).strings.join(' ');
        expect(sql).toContain('seller_id');
        expect(sql).toContain('FOR UPDATE');
      });

      it('ADMIN cobra una venta de otro vendedor: createdByUserId (actorUserId) = ADMIN; el vendedor no se toca', async () => {
        const ADMIN_ID = 'admin-1';
        await service.register({
          ...validRegisterInput,
          actorUserId: ADMIN_ID,
          actorRole: RoleName.ADMIN,
        });
        expect(engine.register).toHaveBeenCalledWith(
          prisma.tx,
          expect.objectContaining({ actorUserId: ADMIN_ID }),
        );
        const command = engine.register.mock.calls[0][1] as Record<
          string,
          unknown
        >;
        expect(command).not.toHaveProperty('sellerId');
      });

      it.each([RoleName.MANAGEMENT, RoleName.WAREHOUSE])(
        '%s no obtiene permiso de cobro (404), ni sobre una venta a su nombre',
        async (role) => {
          await expectSaleNotFound(
            service.register({
              ...validRegisterInput,
              actorUserId: ACTOR_ID,
              actorRole: role,
            }),
          );
          expectNoPaymentEffects();
        },
      );

      it('el dueño sigue sujeto al bloqueo de sobrepago', async () => {
        engine.sumActiveForSale.mockResolvedValue(new Prisma.Decimal('80.00'));
        await expect(
          service.register(sellerInput(ACTOR_ID)),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(engine.register).not.toHaveBeenCalled();
      });

      it('el dueño sigue sujeto a la validación del método (error del motor se propaga)', async () => {
        engine.register.mockRejectedValue(
          new ConflictException('El método de pago "X" está inactivo'),
        );
        await expect(
          service.register(sellerInput(ACTOR_ID)),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(engine.recalculateSaleSummary).not.toHaveBeenCalled();
      });
    });
  });

  // ====================================================================
  // cancel (anulación manual)
  // ====================================================================
  describe('cancel', () => {
    it('bloquea la venta con FOR UPDATE antes de operar sobre el pago', async () => {
      await service.cancel(validCancelInput);
      const sql = (
        prisma.tx.$queryRaw.mock.calls[0][0] as Prisma.Sql
      ).strings.join(' ');
      expect(sql).toContain('FOR UPDATE');
    });

    it('motivo vacío -> 400, sin abrir transacción', async () => {
      await expect(
        service.cancel({ ...validCancelInput, reason: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('venta inexistente -> 404', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([]);
      await expect(service.cancel(validCancelInput)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('venta CANCELLED -> 409', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeSaleLockRow({ status: SaleStatus.CANCELLED }),
      ]);
      await expect(service.cancel(validCancelInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(engine.cancel).not.toHaveBeenCalled();
    });

    it('venta a Público general ACTIVE -> 409, sin invocar al motor (D5)', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeSaleLockRow({ customerIsGeneric: true }),
      ]);
      await expect(service.cancel(validCancelInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(engine.cancel).not.toHaveBeenCalled();
    });

    it('venta normal: delega en PaymentEngine.cancel y luego recalcula el resumen', async () => {
      await service.cancel(validCancelInput);
      expect(engine.cancel).toHaveBeenCalledWith(
        prisma.tx,
        expect.objectContaining({
          saleId: SALE_ID,
          saleNumber: 'NV-000001',
          paymentId: PAYMENT_ID,
          reason: 'Motivo de anulación',
        }),
      );
      expect(engine.recalculateSaleSummary).toHaveBeenCalledWith(
        prisma.tx,
        SALE_ID,
        expect.anything(),
      );
    });

    it('nunca consulta Customer.status', async () => {
      await service.cancel(validCancelInput);
      expect(
        (prisma.tx as unknown as { customer?: unknown }).customer,
      ).toBeUndefined();
    });

    it('retorna { payment, sale }', async () => {
      const result = await service.cancel(validCancelInput);
      expect(result).toHaveProperty('payment');
      expect(result).toHaveProperty('sale');
    });
  });

  // ====================================================================
  // list
  // ====================================================================
  describe('list', () => {
    it('ADMIN: consulta normalmente', async () => {
      const result = await service.list({}, asRole(RoleName.ADMIN));
      expect(prisma.payment.findMany).toHaveBeenCalled();
      expect(result.data).toHaveLength(1);
    });

    it('SELLER: restringido a cobros de SUS ventas (por la venta, nunca por createdByUserId)', async () => {
      await service.list({}, asRole(RoleName.SELLER));
      const call = prisma.payment.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toEqual({
        AND: [{ sale: { sellerId: ACTOR_ID } }, {}],
      });
      expect(JSON.stringify(call.where)).not.toContain('createdByUserId');
    });

    describe('permisos por vendedor (P5)', () => {
      const OWN_SELLER_ID = 'seller-own';
      const OTHER_USER_ID = 'user-other';
      const seller = asRole(RoleName.SELLER, OWN_SELLER_ID);

      function whereOf(call: 'findMany' | 'count'): unknown {
        return (prisma.payment[call].mock.calls[0][0] as { where: unknown })
          .where;
      }

      it('SELLER sin filtros: solo cobros de ventas con sellerId = actor (incluye los registrados por un ADMIN)', async () => {
        await service.list({}, seller);
        expect(whereOf('findMany')).toEqual({
          AND: [{ sale: { sellerId: OWN_SELLER_ID } }, {}],
        });
      });

      it('createdByUserId de otro usuario se combina con AND: solo cobros de SUS ventas registrados por ese usuario', async () => {
        await service.list({ createdByUserId: OTHER_USER_ID }, seller);
        expect(whereOf('findMany')).toEqual({
          AND: [
            { sale: { sellerId: OWN_SELLER_ID } },
            { AND: [{ createdByUserId: OTHER_USER_ID }] },
          ],
        });
      });

      it('un cobro histórico registrado por el SELLER sobre una venta ajena queda fuera: el alcance es la venta, no el cobrador', async () => {
        await service.list({ createdByUserId: OWN_SELLER_ID }, seller);
        const where = whereOf('findMany') as {
          AND: [Record<string, unknown>, unknown];
        };
        // createdByUserId propio NO reemplaza la condición de la venta.
        expect(where.AND[0]).toEqual({ sale: { sellerId: OWN_SELLER_ID } });
      });

      it('findMany y count usan exactamente el mismo where restringido', async () => {
        await service.list(
          { createdByUserId: OTHER_USER_ID, method: 'cash' },
          seller,
        );
        expect(whereOf('count')).toEqual(whereOf('findMany'));
      });

      it('ADMIN y MANAGEMENT: filtros tal cual, sin condición de venta', async () => {
        for (const role of [RoleName.ADMIN, RoleName.MANAGEMENT]) {
          prisma.payment.findMany.mockClear();
          await service.list(
            { createdByUserId: OTHER_USER_ID },
            asRole(role, OWN_SELLER_ID),
          );
          expect(whereOf('findMany')).toEqual({
            AND: [{ createdByUserId: OTHER_USER_ID }],
          });
        }
      });

      it('la lectura no escribe ni altera pagos ni importes', async () => {
        const result = await service.list({}, seller);
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(result.data[0].amount).toBe('40.00');
      });
    });

    it('MANAGEMENT: consulta normalmente', async () => {
      await service.list({}, asRole(RoleName.MANAGEMENT));
      expect(prisma.payment.findMany).toHaveBeenCalled();
    });

    it('WAREHOUSE: página vacía sin consultar Prisma', async () => {
      const result = await service.list({}, asRole(RoleName.WAREHOUSE));
      expect(result).toEqual({
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
      expect(prisma.payment.findMany).not.toHaveBeenCalled();
    });

    it('rol desconocido: página vacía sin consultar Prisma (fail-closed)', async () => {
      const result = await service.list({}, asRole('UNKNOWN' as RoleName));
      expect(result.data).toEqual([]);
      expect(prisma.payment.findMany).not.toHaveBeenCalled();
    });

    it('filtros method/status/createdByUserId se incluyen en el where (method filtra el snapshot paymentMethodCode)', async () => {
      await service.list(
        {
          method: 'CASH',
          status: PaymentStatus.ACTIVE,
          createdByUserId: ACTOR_ID,
        },
        asRole(RoleName.ADMIN),
      );
      const call = prisma.payment.findMany.mock.calls[0][0] as {
        where: { AND: Record<string, unknown>[] };
      };
      expect(call.where.AND).toEqual(
        expect.arrayContaining([
          { paymentMethodCode: 'CASH' },
          { status: PaymentStatus.ACTIVE },
          { createdByUserId: ACTOR_ID },
        ]),
      );
    });

    it('method se normaliza a mayúsculas antes de filtrar', async () => {
      await service.list({ method: 'cash' }, asRole(RoleName.ADMIN));
      const call = prisma.payment.findMany.mock.calls[0][0] as {
        where: { AND: Record<string, unknown>[] };
      };
      expect(call.where.AND).toEqual(
        expect.arrayContaining([{ paymentMethodCode: 'CASH' }]),
      );
    });

    it('paidFrom/paidTo inválidos -> 400', async () => {
      await expect(
        service.list({ paidFrom: 'no-es-fecha' }, asRole(RoleName.ADMIN)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('paidFrom > paidTo -> 400', async () => {
      await expect(
        service.list(
          { paidFrom: '2026-03-20', paidTo: '2026-03-10' },
          asRole(RoleName.ADMIN),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('orden paidAt desc, id desc', async () => {
      await service.list({}, asRole(RoleName.ADMIN));
      const call = prisma.payment.findMany.mock.calls[0][0] as {
        orderBy: unknown;
      };
      expect(call.orderBy).toEqual([{ paidAt: 'desc' }, { id: 'desc' }]);
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

    it('findMany y count usan el mismo where', async () => {
      await service.list({ method: 'CARD' }, asRole(RoleName.ADMIN));
      const findManyWhere = (
        prisma.payment.findMany.mock.calls[0][0] as { where: unknown }
      ).where;
      const countWhere = (
        prisma.payment.count.mock.calls[0][0] as { where: unknown }
      ).where;
      expect(findManyWhere).toEqual(countWhere);
    });
  });
});

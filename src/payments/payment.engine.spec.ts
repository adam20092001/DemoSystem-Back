import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  AccountingEventType,
  AccountingSourceType,
  PaymentCancellationSource,
  PaymentMethodAccountingDestination,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { AccountingEngine } from '../accounting/accounting.engine';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PaymentMethodReader } from '../payment-methods/payment-method-reader.service';
import { SafePaymentMethod } from '../payment-methods/types/safe-payment-method';
import { PAYMENT_SAFE_SELECT } from './mappers/payment.mapper';
import { PaymentEngine } from './payment.engine';
import {
  CancelAllActivePaymentsCommand,
  CancelPaymentCommand,
  RegisterPaymentCommand,
} from './types/payment-command';

const SALE_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const PAYMENT_ID = '33333333-3333-4333-8333-333333333333';
const METHOD_ID = '44444444-4444-4444-8444-444444444444';
const SALE_NUMBER = 'NV-000001';
const CANCELLED_AT = new Date('2026-04-01T09:30:00.000Z');

/** Método dinámico resuelto por defecto: equivalente al baseline CASH (Ticket C, Bloque C1). */
function makeResolvedMethod(
  overrides: Partial<SafePaymentMethod> = {},
): SafePaymentMethod {
  return {
    id: METHOD_ID,
    code: 'CASH',
    name: 'Efectivo',
    active: true,
    requiresReference: false,
    affectsCashDrawer: true,
    accountingDestination: PaymentMethodAccountingDestination.CASH,
    sortOrder: 10,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
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

function makeRegisterCommand(
  overrides: Partial<RegisterPaymentCommand> = {},
): RegisterPaymentCommand {
  return {
    saleId: SALE_ID,
    saleNumber: SALE_NUMBER,
    method: 'CASH',
    amount: new Prisma.Decimal('40.00'),
    reference: null,
    actorUserId: ACTOR_ID,
    ipAddress: null,
    ...overrides,
  };
}

function makeCancelCommand(
  overrides: Partial<CancelPaymentCommand> = {},
): CancelPaymentCommand {
  return {
    saleId: SALE_ID,
    saleNumber: SALE_NUMBER,
    paymentId: PAYMENT_ID,
    reason: 'Motivo de anulación de prueba',
    actorUserId: ACTOR_ID,
    ipAddress: null,
    ...overrides,
  };
}

function makeCancelAllCommand(
  overrides: Partial<CancelAllActivePaymentsCommand> = {},
): CancelAllActivePaymentsCommand {
  return {
    saleId: SALE_ID,
    saleNumber: SALE_NUMBER,
    actorUserId: ACTOR_ID,
    ipAddress: null,
    cancelledAt: CANCELLED_AT,
    ...overrides,
  };
}

function createTxMock() {
  return {
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>(),
    payment: {
      create: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      update: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      aggregate: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    sale: {
      update: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
  };
}

function createAuditServiceMock() {
  return { record: jest.fn<Promise<void>, [Record<string, unknown>]>() };
}

function createAccountingEngineMock() {
  return {
    postPaymentCollection: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    reverseOriginalForSource: jest.fn<Promise<unknown>, [unknown, unknown]>(),
  };
}

function createPaymentMethodReaderMock() {
  return {
    findByCode: jest.fn<
      Promise<SafePaymentMethod | null>,
      [string, unknown?]
    >(),
  };
}

describe('PaymentEngine', () => {
  let tx: ReturnType<typeof createTxMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let accountingEngine: ReturnType<typeof createAccountingEngineMock>;
  let paymentMethodReader: ReturnType<typeof createPaymentMethodReaderMock>;
  let engine: PaymentEngine;

  beforeEach(() => {
    tx = createTxMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    accountingEngine = createAccountingEngineMock();
    accountingEngine.postPaymentCollection.mockResolvedValue({
      id: 'entry-1',
      sourceType: AccountingSourceType.PAYMENT,
      sourceId: PAYMENT_ID,
      eventType: AccountingEventType.ORIGINAL,
    });
    accountingEngine.reverseOriginalForSource.mockResolvedValue({
      id: 'entry-2',
      sourceType: AccountingSourceType.PAYMENT,
      sourceId: PAYMENT_ID,
      eventType: AccountingEventType.REVERSAL,
    });
    paymentMethodReader = createPaymentMethodReaderMock();
    paymentMethodReader.findByCode.mockResolvedValue(makeResolvedMethod());
    engine = new PaymentEngine(
      auditService as unknown as AuditService,
      accountingEngine as unknown as AccountingEngine,
      paymentMethodReader as unknown as PaymentMethodReader,
    );

    tx.payment.create.mockResolvedValue(makePaymentRow());
    tx.payment.update.mockResolvedValue(
      makePaymentRow({ status: PaymentStatus.CANCELLED }),
    );
    tx.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
    tx.sale.update.mockResolvedValue({});
    tx.$queryRaw.mockResolvedValue([]);
  });

  // ====================================================================
  // register
  // ====================================================================
  describe('register', () => {
    it('nunca abre una transacción propia (no existe this.prisma.$transaction en la clase)', () => {
      expect(
        (engine as unknown as { prisma?: unknown }).prisma,
      ).toBeUndefined();
    });

    it('resuelve el método dinámico contra el MISMO tx recibido, nunca una conexión Prisma independiente (Ticket C, Bloque C3)', async () => {
      await engine.register(
        tx as unknown as Prisma.TransactionClient,
        makeRegisterCommand(),
      );
      expect(paymentMethodReader.findByCode).toHaveBeenCalledWith('CASH', tx);
    });

    it('normaliza el código (trim + mayúsculas) antes de resolver', async () => {
      await engine.register(
        tx as unknown as Prisma.TransactionClient,
        makeRegisterCommand({ method: '  cash  ' }),
      );
      expect(paymentMethodReader.findByCode).toHaveBeenCalledWith('CASH', tx);
    });

    it('código inexistente -> 404, nunca crea el Payment', async () => {
      paymentMethodReader.findByCode.mockResolvedValue(null);
      await expect(
        engine.register(
          tx as unknown as Prisma.TransactionClient,
          makeRegisterCommand({ method: 'NOPE' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.payment.create).not.toHaveBeenCalled();
    });

    it('código existente pero inactivo -> 409, nunca crea el Payment', async () => {
      paymentMethodReader.findByCode.mockResolvedValue(
        makeResolvedMethod({ active: false }),
      );
      await expect(
        engine.register(
          tx as unknown as Prisma.TransactionClient,
          makeRegisterCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.payment.create).not.toHaveBeenCalled();
    });

    it('usa el tx recibido para crear el pago con select seguro', async () => {
      await engine.register(
        tx as unknown as Prisma.TransactionClient,
        makeRegisterCommand(),
      );
      expect(tx.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({ select: PAYMENT_SAFE_SELECT }),
      );
    });

    it('crea el pago ACTIVE con paidAt propio, createdByUserId del actor, snapshot del método resuelto, y campos de anulación null', async () => {
      const before = Date.now();
      await engine.register(
        tx as unknown as Prisma.TransactionClient,
        makeRegisterCommand(),
      );
      const after = Date.now();

      const call = tx.payment.create.mock.calls[0][0] as {
        data: {
          status: PaymentStatus;
          paidAt: Date;
          createdByUserId: string;
          paymentMethodId: string;
          paymentMethodCode: string;
          paymentMethodName: string;
          paymentMethodAffectsCashDrawer: boolean;
          cancelledAt: unknown;
          cancellationReason: unknown;
          cancelledByUserId: unknown;
          cancellationSource: unknown;
        };
      };
      expect(call.data.status).toBe(PaymentStatus.ACTIVE);
      expect(call.data.createdByUserId).toBe(ACTOR_ID);
      expect(call.data.paidAt).toBeInstanceOf(Date);
      expect(call.data.paidAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(call.data.paidAt.getTime()).toBeLessThanOrEqual(after);
      // Snapshot histórico (Ticket C, Bloque C3): congelado desde el método
      // resuelto en este instante, nunca releído después.
      expect(call.data.paymentMethodId).toBe(METHOD_ID);
      expect(call.data.paymentMethodCode).toBe('CASH');
      expect(call.data.paymentMethodName).toBe('Efectivo');
      expect(call.data.paymentMethodAffectsCashDrawer).toBe(true);
      // Ninguno de los 4 campos de anulación se incluye en el INSERT: la
      // columna es NULLABLE sin @default, así que omitirlos por completo
      // equivale a NULL en la base (mismo criterio de la fila ACTIVE del
      // CHECK payments_cancellation_consistency).
      expect(call.data.cancelledAt).toBeUndefined();
      expect(call.data.cancellationReason).toBeUndefined();
      expect(call.data.cancelledByUserId).toBeUndefined();
      expect(call.data.cancellationSource).toBeUndefined();
    });

    it('el llamador NO puede fijar paidAt/status/createdBy/cancelación: no forman parte del comando aceptado', () => {
      const command = makeRegisterCommand();
      expect(command).not.toHaveProperty('paidAt');
      expect(command).not.toHaveProperty('status');
      expect(command).not.toHaveProperty('cancelledAt');
    });

    it('revalida defensivamente el monto (monto <= 0 -> error controlado, aunque el comando ya venga "parseado")', async () => {
      await expect(
        engine.register(
          tx as unknown as Prisma.TransactionClient,
          makeRegisterCommand({ amount: new Prisma.Decimal('0') }),
        ),
      ).rejects.toThrow();
      expect(tx.payment.create).not.toHaveBeenCalled();
    });

    it('revalida defensivamente la referencia exigida por el método RESUELTO (requiresReference=true sin referencia -> error)', async () => {
      paymentMethodReader.findByCode.mockResolvedValue(
        makeResolvedMethod({ code: 'TRANSFER', requiresReference: true }),
      );
      await expect(
        engine.register(
          tx as unknown as Prisma.TransactionClient,
          makeRegisterCommand({ method: 'TRANSFER', reference: null }),
        ),
      ).rejects.toThrow();
      expect(tx.payment.create).not.toHaveBeenCalled();
    });

    it('audita PAYMENT_REGISTERED exactamente una vez, con la whitelist exacta (method = code resuelto) y usando el mismo tx', async () => {
      await engine.register(
        tx as unknown as Prisma.TransactionClient,
        makeRegisterCommand(),
      );
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        entityType: string;
        entityId: string;
        metadata: Record<string, unknown>;
        client: unknown;
      };
      expect(call.action).toBe(AuditAction.PAYMENT_REGISTERED);
      expect(call.entityType).toBe('Payment');
      expect(call.entityId).toBe(PAYMENT_ID);
      expect(call.metadata).toEqual({
        saleId: SALE_ID,
        saleNumber: SALE_NUMBER,
        method: 'CASH',
      });
      expect(call.client).toBe(tx);
    });

    it('la metadata nunca incluye amount ni reference', async () => {
      await engine.register(
        tx as unknown as Prisma.TransactionClient,
        makeRegisterCommand({
          reference: 'OP-999',
          amount: new Prisma.Decimal('77.00'),
        }),
      );
      const call = auditService.record.mock.calls[0][0] as {
        metadata: Record<string, unknown>;
      };
      expect(call.metadata).not.toHaveProperty('amount');
      expect(call.metadata).not.toHaveProperty('reference');
    });

    it('retorna el pago mapeado a forma segura (amount como string de 2 decimales, method/methodName snapshoteados)', async () => {
      const result = await engine.register(
        tx as unknown as Prisma.TransactionClient,
        makeRegisterCommand(),
      );
      expect(result.id).toBe(PAYMENT_ID);
      expect(result.amount).toBe('40.00');
      expect(result.status).toBe(PaymentStatus.ACTIVE);
      expect(result.method).toBe('CASH');
      expect(result.methodName).toBe('Efectivo');
    });

    it('no actualiza el resumen de la venta (sale.update nunca se llama desde register)', async () => {
      await engine.register(
        tx as unknown as Prisma.TransactionClient,
        makeRegisterCommand(),
      );
      expect(tx.sale.update).not.toHaveBeenCalled();
    });

    describe('integración contable (Fase 8, Bloque B; recableada en Ticket C, Bloque C3)', () => {
      it('crea el Payment ANTES de postear el cobro contable, con el MISMO tx', async () => {
        await engine.register(
          tx as unknown as Prisma.TransactionClient,
          makeRegisterCommand(),
        );
        expect(tx.payment.create).toHaveBeenCalledTimes(1);
        expect(accountingEngine.postPaymentCollection).toHaveBeenCalledTimes(1);
        const createOrder = tx.payment.create.mock.invocationCallOrder[0];
        const postOrder =
          accountingEngine.postPaymentCollection.mock.invocationCallOrder[0];
        expect(createOrder).toBeLessThan(postOrder);
        expect(accountingEngine.postPaymentCollection.mock.calls[0][0]).toBe(
          tx,
        );
      });

      it('postedAt del asiento de cobro es EXACTAMENTE el paidAt persistido en el Payment (mismo instante, no dos)', async () => {
        await engine.register(
          tx as unknown as Prisma.TransactionClient,
          makeRegisterCommand(),
        );
        const persistedPaidAt = (
          tx.payment.create.mock.calls[0][0] as {
            data: { paidAt: Date };
          }
        ).data.paidAt;
        const postedAt = (
          accountingEngine.postPaymentCollection.mock.calls[0][1] as {
            postedAt: Date;
          }
        ).postedAt;
        expect(postedAt).toBe(persistedPaidAt);
      });

      it('propaga saleNumber/accountingDestination (YA resuelto)/amount/actor/ip correctos a postPaymentCollection — nunca el método completo', async () => {
        paymentMethodReader.findByCode.mockResolvedValue(
          makeResolvedMethod({
            code: 'CARD',
            accountingDestination: PaymentMethodAccountingDestination.BANK,
          }),
        );
        await engine.register(
          tx as unknown as Prisma.TransactionClient,
          makeRegisterCommand({
            method: 'CARD',
            amount: new Prisma.Decimal('77.50'),
            reference: 'OP-000456',
            ipAddress: '203.0.113.5',
          }),
        );
        const command = accountingEngine.postPaymentCollection.mock
          .calls[0][1] as {
          paymentId: string;
          saleNumber: string;
          accountingDestination: PaymentMethodAccountingDestination;
          amount: Prisma.Decimal;
          actorUserId: string;
          ipAddress: string | null;
        };
        expect(command.paymentId).toBe(PAYMENT_ID);
        expect(command.saleNumber).toBe(SALE_NUMBER);
        expect(command.accountingDestination).toBe(
          PaymentMethodAccountingDestination.BANK,
        );
        expect(command).not.toHaveProperty('method');
        expect(command.amount.toFixed(2)).toBe('77.50');
        expect(command.actorUserId).toBe(ACTOR_ID);
        expect(command.ipAddress).toBe('203.0.113.5');
      });

      it('PAYMENT_REGISTERED sigue auditándose exactamente una vez; PaymentEngine nunca escribe ACCOUNTING_ENTRY_* él mismo', async () => {
        await engine.register(
          tx as unknown as Prisma.TransactionClient,
          makeRegisterCommand(),
        );
        expect(auditService.record).toHaveBeenCalledTimes(1);
        expect(
          (auditService.record.mock.calls[0][0] as { action: AuditAction })
            .action,
        ).toBe(AuditAction.PAYMENT_REGISTERED);
      });

      it('si AccountingEngine rechaza, register() rechaza y el Payment nunca se retorna', async () => {
        accountingEngine.postPaymentCollection.mockRejectedValue(
          new Error('fallo contable interno'),
        );
        await expect(
          engine.register(
            tx as unknown as Prisma.TransactionClient,
            makeRegisterCommand(),
          ),
        ).rejects.toThrow('fallo contable interno');
        // La auditoría de negocio nunca se alcanza si la contable falla antes.
        expect(auditService.record).not.toHaveBeenCalled();
      });
    });
  });

  // ====================================================================
  // sumActiveForSale / recalculateSaleSummary
  // ====================================================================
  describe('sumActiveForSale', () => {
    it('sin pagos ACTIVE -> 0', async () => {
      tx.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
      const result = await engine.sumActiveForSale(
        tx as unknown as Prisma.TransactionClient,
        SALE_ID,
      );
      expect(result.toFixed(2)).toBe('0.00');
    });

    it('agrega solo status=ACTIVE en el where', async () => {
      await engine.sumActiveForSale(
        tx as unknown as Prisma.TransactionClient,
        SALE_ID,
      );
      expect(tx.payment.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { saleId: SALE_ID, status: PaymentStatus.ACTIVE },
        }),
      );
    });

    it('retorna la suma cuando hay pagos', async () => {
      tx.payment.aggregate.mockResolvedValue({
        _sum: { amount: new Prisma.Decimal('150.00') },
      });
      const result = await engine.sumActiveForSale(
        tx as unknown as Prisma.TransactionClient,
        SALE_ID,
      );
      expect(result.toFixed(2)).toBe('150.00');
    });
  });

  describe('recalculateSaleSummary', () => {
    it('UNPAID: sin pagos ACTIVE, total > 0', async () => {
      tx.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
      const summary = await engine.recalculateSaleSummary(
        tx as unknown as Prisma.TransactionClient,
        SALE_ID,
        new Prisma.Decimal('100.00'),
      );
      expect(summary.paymentStatus).toBe('UNPAID');
      expect(summary.paidAmount.toFixed(2)).toBe('0.00');
      expect(summary.balanceDue.toFixed(2)).toBe('100.00');
    });

    it('PARTIALLY_PAID: suma parcial', async () => {
      tx.payment.aggregate.mockResolvedValue({
        _sum: { amount: new Prisma.Decimal('40.00') },
      });
      const summary = await engine.recalculateSaleSummary(
        tx as unknown as Prisma.TransactionClient,
        SALE_ID,
        new Prisma.Decimal('100.00'),
      );
      expect(summary.paymentStatus).toBe('PARTIALLY_PAID');
      expect(summary.balanceDue.toFixed(2)).toBe('60.00');
    });

    it('PAID: suma igual al total', async () => {
      tx.payment.aggregate.mockResolvedValue({
        _sum: { amount: new Prisma.Decimal('100.00') },
      });
      const summary = await engine.recalculateSaleSummary(
        tx as unknown as Prisma.TransactionClient,
        SALE_ID,
        new Prisma.Decimal('100.00'),
      );
      expect(summary.paymentStatus).toBe('PAID');
      expect(summary.balanceDue.toFixed(2)).toBe('0.00');
    });

    it('actualiza únicamente paidAmount/balanceDue/paymentStatus en Sale, dentro del mismo tx', async () => {
      tx.payment.aggregate.mockResolvedValue({
        _sum: { amount: new Prisma.Decimal('40.00') },
      });
      await engine.recalculateSaleSummary(
        tx as unknown as Prisma.TransactionClient,
        SALE_ID,
        new Prisma.Decimal('100.00'),
      );
      expect(tx.sale.update).toHaveBeenCalledTimes(1);
      const call = tx.sale.update.mock.calls[0][0] as {
        where: { id: string };
        data: Record<string, unknown>;
      };
      expect(call.where).toEqual({ id: SALE_ID });
      expect(call.data.paymentStatus).toBe('PARTIALLY_PAID');
      expect(Object.keys(call.data).sort()).toEqual(
        ['balanceDue', 'paidAmount', 'paymentStatus'].sort(),
      );
    });

    it('nunca consulta Customer', async () => {
      await engine.recalculateSaleSummary(
        tx as unknown as Prisma.TransactionClient,
        SALE_ID,
        new Prisma.Decimal('100.00'),
      );
      expect(
        (tx as unknown as { customer?: unknown }).customer,
      ).toBeUndefined();
    });
  });

  // ====================================================================
  // cancel (anulación MANUAL de un pago específico)
  // ====================================================================
  describe('cancel', () => {
    it('bloquea el pago con FOR UPDATE filtrando por id Y saleId', async () => {
      tx.$queryRaw.mockResolvedValue([
        { id: PAYMENT_ID, saleId: SALE_ID, status: PaymentStatus.ACTIVE },
      ]);
      await engine.cancel(
        tx as unknown as Prisma.TransactionClient,
        makeCancelCommand(),
      );
      const sql = (tx.$queryRaw.mock.calls[0][0] as Prisma.Sql).strings.join(
        ' ',
      );
      expect(sql).toContain('FOR UPDATE');
      expect(sql).toContain('sale_id');
    });

    it('pago inexistente -> 404', async () => {
      tx.$queryRaw.mockResolvedValue([]);
      await expect(
        engine.cancel(
          tx as unknown as Prisma.TransactionClient,
          makeCancelCommand(),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('pago ya CANCELLED -> 409', async () => {
      tx.$queryRaw.mockResolvedValue([
        { id: PAYMENT_ID, saleId: SALE_ID, status: PaymentStatus.CANCELLED },
      ]);
      await expect(
        engine.cancel(
          tx as unknown as Prisma.TransactionClient,
          makeCancelCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('transición exitosa: status CANCELLED, source MANUAL, reason normalizado, cancelledAt/cancelledBy fijados', async () => {
      tx.$queryRaw.mockResolvedValue([
        { id: PAYMENT_ID, saleId: SALE_ID, status: PaymentStatus.ACTIVE },
      ]);
      await engine.cancel(
        tx as unknown as Prisma.TransactionClient,
        makeCancelCommand({ reason: 'Motivo válido' }),
      );
      const call = tx.payment.update.mock.calls[0][0] as {
        data: {
          status: PaymentStatus;
          cancelledAt: Date;
          cancelledByUserId: string;
          cancellationSource: PaymentCancellationSource;
          cancellationReason: string;
        };
      };
      expect(call.data.status).toBe(PaymentStatus.CANCELLED);
      expect(call.data.cancelledAt).toBeInstanceOf(Date);
      expect(call.data.cancelledByUserId).toBe(ACTOR_ID);
      expect(call.data.cancellationSource).toBe(
        PaymentCancellationSource.MANUAL,
      );
      expect(call.data.cancellationReason).toBe('Motivo válido');
    });

    it('nunca vuelve a resolver el PaymentMethod actual (Ticket C, Bloque C3: revierte el asiento ya posteado, no releído)', async () => {
      tx.$queryRaw.mockResolvedValue([
        { id: PAYMENT_ID, saleId: SALE_ID, status: PaymentStatus.ACTIVE },
      ]);
      await engine.cancel(
        tx as unknown as Prisma.TransactionClient,
        makeCancelCommand(),
      );
      expect(paymentMethodReader.findByCode).not.toHaveBeenCalled();
    });

    it('audita PAYMENT_CANCELLED exactamente una vez, con whitelist exacta (sin reason/amount/reference)', async () => {
      tx.$queryRaw.mockResolvedValue([
        { id: PAYMENT_ID, saleId: SALE_ID, status: PaymentStatus.ACTIVE },
      ]);
      await engine.cancel(
        tx as unknown as Prisma.TransactionClient,
        makeCancelCommand(),
      );
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        metadata: Record<string, unknown>;
        client: unknown;
      };
      expect(call.action).toBe(AuditAction.PAYMENT_CANCELLED);
      expect(call.metadata).toEqual({
        saleId: SALE_ID,
        saleNumber: SALE_NUMBER,
        previousStatus: PaymentStatus.ACTIVE,
        cancellationSource: PaymentCancellationSource.MANUAL,
      });
      expect(call.client).toBe(tx);
    });

    it('no actualiza el resumen de la venta (sale.update nunca se llama desde cancel)', async () => {
      tx.$queryRaw.mockResolvedValue([
        { id: PAYMENT_ID, saleId: SALE_ID, status: PaymentStatus.ACTIVE },
      ]);
      await engine.cancel(
        tx as unknown as Prisma.TransactionClient,
        makeCancelCommand(),
      );
      expect(tx.sale.update).not.toHaveBeenCalled();
    });

    describe('integración contable (Fase 8, Bloque B)', () => {
      beforeEach(() => {
        tx.$queryRaw.mockResolvedValue([
          { id: PAYMENT_ID, saleId: SALE_ID, status: PaymentStatus.ACTIVE },
        ]);
      });

      it('el MISMO cancelledAt se usa para Payment.cancelledAt y para el postedAt de la reversión contable', async () => {
        await engine.cancel(
          tx as unknown as Prisma.TransactionClient,
          makeCancelCommand(),
        );
        const persistedCancelledAt = (
          tx.payment.update.mock.calls[0][0] as {
            data: { cancelledAt: Date };
          }
        ).data.cancelledAt;
        const postedAt = (
          accountingEngine.reverseOriginalForSource.mock.calls[0][1] as {
            postedAt: Date;
          }
        ).postedAt;
        expect(postedAt).toBe(persistedCancelledAt);
      });

      it('reversa exactamente una vez, con sourceType PAYMENT/sourceId/sourceNumber/actor/ip correctos, mismo tx', async () => {
        await engine.cancel(
          tx as unknown as Prisma.TransactionClient,
          makeCancelCommand({ ipAddress: '203.0.113.5' }),
        );
        expect(accountingEngine.reverseOriginalForSource).toHaveBeenCalledTimes(
          1,
        );
        const [calledTx, command] =
          accountingEngine.reverseOriginalForSource.mock.calls[0];
        expect(calledTx).toBe(tx);
        expect(
          (command as { sourceType: AccountingSourceType }).sourceType,
        ).toBe(AccountingSourceType.PAYMENT);
        expect((command as { sourceId: string }).sourceId).toBe(PAYMENT_ID);
        expect((command as { sourceNumber: string }).sourceNumber).toBe(
          SALE_NUMBER,
        );
        expect((command as { actorUserId: string }).actorUserId).toBe(ACTOR_ID);
        expect((command as { ipAddress: string | null }).ipAddress).toBe(
          '203.0.113.5',
        );
      });

      it('PAYMENT_CANCELLED se audita exactamente una vez; PaymentEngine nunca escribe ACCOUNTING_ENTRY_* él mismo', async () => {
        await engine.cancel(
          tx as unknown as Prisma.TransactionClient,
          makeCancelCommand(),
        );
        expect(auditService.record).toHaveBeenCalledTimes(1);
        expect(
          (auditService.record.mock.calls[0][0] as { action: AuditAction })
            .action,
        ).toBe(AuditAction.PAYMENT_CANCELLED);
      });

      it('si la reversión contable falla, cancel() rechaza (la anulación del Payment debe revertirse con toda la transacción)', async () => {
        accountingEngine.reverseOriginalForSource.mockRejectedValue(
          new Error('fallo contable interno'),
        );
        await expect(
          engine.cancel(
            tx as unknown as Prisma.TransactionClient,
            makeCancelCommand(),
          ),
        ).rejects.toThrow('fallo contable interno');
        expect(auditService.record).not.toHaveBeenCalled();
      });
    });
  });

  // ====================================================================
  // cancelAllActiveForSale (anulación automática en cascada)
  // ====================================================================
  describe('cancelAllActiveForSale', () => {
    it('cero pagos ACTIVE -> no-op, retorna []', async () => {
      tx.$queryRaw.mockResolvedValue([]);
      const result = await engine.cancelAllActiveForSale(
        tx as unknown as Prisma.TransactionClient,
        makeCancelAllCommand(),
      );
      expect(result).toEqual([]);
      expect(tx.payment.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('un pago ACTIVE: se anula con source SALE_CANCELLATION y reason null', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: PAYMENT_ID }]);
      await engine.cancelAllActiveForSale(
        tx as unknown as Prisma.TransactionClient,
        makeCancelAllCommand(),
      );
      const call = tx.payment.update.mock.calls[0][0] as {
        data: {
          status: PaymentStatus;
          cancellationSource: PaymentCancellationSource;
          cancellationReason: string | null;
          cancelledByUserId: string;
        };
      };
      expect(call.data.status).toBe(PaymentStatus.CANCELLED);
      expect(call.data.cancellationSource).toBe(
        PaymentCancellationSource.SALE_CANCELLATION,
      );
      expect(call.data.cancellationReason).toBeNull();
      expect(call.data.cancelledByUserId).toBe(ACTOR_ID);
    });

    it('múltiples pagos ACTIVE: cada uno se transiciona y audita exactamente una vez', async () => {
      tx.$queryRaw.mockResolvedValue([
        { id: 'payment-a' },
        { id: 'payment-b' },
        { id: 'payment-c' },
      ]);
      tx.payment.update.mockImplementation((args: unknown) => {
        const { where } = args as { where: { id: string } };
        return Promise.resolve(
          makePaymentRow({ id: where.id, status: PaymentStatus.CANCELLED }),
        );
      });

      const result = await engine.cancelAllActiveForSale(
        tx as unknown as Prisma.TransactionClient,
        makeCancelAllCommand(),
      );

      expect(tx.payment.update).toHaveBeenCalledTimes(3);
      expect(auditService.record).toHaveBeenCalledTimes(3);
      expect(result).toHaveLength(3);
      for (const call of auditService.record.mock.calls) {
        expect((call[0] as { action: AuditAction }).action).toBe(
          AuditAction.PAYMENT_CANCELLED,
        );
      }
    });

    it('consulta ordenada por paidAt ASC, id ASC', async () => {
      tx.$queryRaw.mockResolvedValue([]);
      await engine.cancelAllActiveForSale(
        tx as unknown as Prisma.TransactionClient,
        makeCancelAllCommand(),
      );
      const sql = (tx.$queryRaw.mock.calls[0][0] as Prisma.Sql).strings.join(
        ' ',
      );
      expect(sql).toContain('ORDER BY');
      expect(sql).toContain('paid_at');
      expect(sql).toContain('FOR UPDATE');
    });

    it('solo consulta pagos de la venta indicada (status ACTIVE, sale_id)', async () => {
      tx.$queryRaw.mockResolvedValue([]);
      await engine.cancelAllActiveForSale(
        tx as unknown as Prisma.TransactionClient,
        makeCancelAllCommand(),
      );
      const sql = (tx.$queryRaw.mock.calls[0][0] as Prisma.Sql).strings.join(
        ' ',
      );
      expect(sql).toContain('sale_id');
      expect(sql).toContain('status');
    });

    it('no actualiza el resumen de la venta (SalesService congela el resumen)', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: PAYMENT_ID }]);
      await engine.cancelAllActiveForSale(
        tx as unknown as Prisma.TransactionClient,
        makeCancelAllCommand(),
      );
      expect(tx.sale.update).not.toHaveBeenCalled();
    });

    it('nunca vuelve a resolver el PaymentMethod actual', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: PAYMENT_ID }]);
      await engine.cancelAllActiveForSale(
        tx as unknown as Prisma.TransactionClient,
        makeCancelAllCommand(),
      );
      expect(paymentMethodReader.findByCode).not.toHaveBeenCalled();
    });

    describe('integración contable (Fase 8, Bloque B)', () => {
      it('cero pagos ACTIVE: ninguna reversión contable', async () => {
        tx.$queryRaw.mockResolvedValue([]);
        await engine.cancelAllActiveForSale(
          tx as unknown as Prisma.TransactionClient,
          makeCancelAllCommand(),
        );
        expect(
          accountingEngine.reverseOriginalForSource,
        ).not.toHaveBeenCalled();
      });

      it('un pago ACTIVE: exactamente una reversión contable, con el cancelledAt de la OPERACIÓN', async () => {
        tx.$queryRaw.mockResolvedValue([{ id: PAYMENT_ID }]);
        await engine.cancelAllActiveForSale(
          tx as unknown as Prisma.TransactionClient,
          makeCancelAllCommand({ cancelledAt: CANCELLED_AT }),
        );
        expect(accountingEngine.reverseOriginalForSource).toHaveBeenCalledTimes(
          1,
        );
        const command = accountingEngine.reverseOriginalForSource.mock
          .calls[0][1] as {
          sourceType: AccountingSourceType;
          sourceId: string;
          postedAt: Date;
        };
        expect(command.sourceType).toBe(AccountingSourceType.PAYMENT);
        expect(command.sourceId).toBe(PAYMENT_ID);
        expect(command.postedAt).toBe(CANCELLED_AT);
      });

      it('múltiples pagos ACTIVE: una reversión contable por pago, TODAS con el MISMO cancelledAt de operación', async () => {
        tx.$queryRaw.mockResolvedValue([
          { id: 'payment-a' },
          { id: 'payment-b' },
          { id: 'payment-c' },
        ]);
        await engine.cancelAllActiveForSale(
          tx as unknown as Prisma.TransactionClient,
          makeCancelAllCommand({ cancelledAt: CANCELLED_AT }),
        );
        expect(accountingEngine.reverseOriginalForSource).toHaveBeenCalledTimes(
          3,
        );
        for (const call of accountingEngine.reverseOriginalForSource.mock
          .calls) {
          expect((call[1] as { postedAt: Date }).postedAt).toBe(CANCELLED_AT);
        }
        const reversedIds =
          accountingEngine.reverseOriginalForSource.mock.calls.map(
            (call) => (call[1] as { sourceId: string }).sourceId,
          );
        expect(reversedIds).toEqual(['payment-a', 'payment-b', 'payment-c']);
      });

      it('Payment.cancelledAt persistido coincide con el cancelledAt de la reversión contable, para cada pago', async () => {
        tx.$queryRaw.mockResolvedValue([{ id: PAYMENT_ID }]);
        await engine.cancelAllActiveForSale(
          tx as unknown as Prisma.TransactionClient,
          makeCancelAllCommand({ cancelledAt: CANCELLED_AT }),
        );
        const persistedCancelledAt = (
          tx.payment.update.mock.calls[0][0] as {
            data: { cancelledAt: Date };
          }
        ).data.cancelledAt;
        expect(persistedCancelledAt).toBe(CANCELLED_AT);
      });

      it('si una reversión contable falla, cancelAllActiveForSale rechaza (propaga a la transacción de anulación de venta)', async () => {
        tx.$queryRaw.mockResolvedValue([{ id: PAYMENT_ID }]);
        accountingEngine.reverseOriginalForSource.mockRejectedValue(
          new Error('fallo contable interno'),
        );
        await expect(
          engine.cancelAllActiveForSale(
            tx as unknown as Prisma.TransactionClient,
            makeCancelAllCommand(),
          ),
        ).rejects.toThrow('fallo contable interno');
      });
    });
  });
});

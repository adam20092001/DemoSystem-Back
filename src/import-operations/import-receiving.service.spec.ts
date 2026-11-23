import { ForbiddenException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { ImportReceivingService } from './import-receiving.service';

/**
 * Pruebas unitarias de las validaciones PREVIAS a la transacción del
 * coordinador (permisos, Idempotency-Key, entrada). La composición transaccional
 * (locks, stock, valorización, vínculos, cierre atómico, concurrencia) se prueba
 * contra PostgreSQL real en test/r5-import-receiving.e2e-spec.ts.
 */
describe('ImportReceivingService (validaciones previas)', () => {
  const transaction = jest.fn();
  const service = new ImportReceivingService(
    { $transaction: transaction } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const LINE = '11111111-1111-4111-8111-111111111111';
  const base = {
    importOperationId: '22222222-2222-4222-8222-222222222222',
    importShipmentId: '33333333-3333-4333-8333-333333333333',
    actorUserId: '44444444-4444-4444-8444-444444444444',
    ipAddress: null,
  };
  const body = (lines: { importShipmentLineId: string; quantity: string }[]) =>
    ({ lines }) as never;

  beforeEach(() => transaction.mockReset());

  it.each([
    RoleName.WAREHOUSE,
    RoleName.SELLER,
    RoleName.MANAGEMENT,
    RoleName.ACCOUNTANT,
  ])('%s no puede registrar recepciones desde importaciones', async (role) => {
    await expect(
      service.receive({
        ...base,
        requesterRole: role,
        idempotencyKey: 'k1',
        body: body([{ importShipmentLineId: LINE, quantity: '1.000' }]),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.linkExisting({
        ...base,
        requesterRole: role,
        idempotencyKey: 'k1',
        body: { links: [] },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([RoleName.WAREHOUSE, RoleName.SELLER])(
    '%s no puede consultar los pendientes de recepción',
    async (role) => {
      await expect(
        service.getSummary(base.importOperationId, role),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('exige Idempotency-Key válida antes de abrir ninguna transacción', async () => {
    const run = (idempotencyKey: string | undefined) =>
      service.receive({
        ...base,
        requesterRole: RoleName.PURCHASING,
        idempotencyKey,
        body: body([{ importShipmentLineId: LINE, quantity: '1.000' }]),
      });
    await expect(run(undefined)).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REQUIRED' },
    });
    await expect(run('   ')).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REQUIRED' },
    });
    await expect(run('con espacios!')).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_INVALID' },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rechaza líneas repetidas o con cantidad cero señalando el campo exacto', async () => {
    const run = (lines: { importShipmentLineId: string; quantity: string }[]) =>
      service.receive({
        ...base,
        requesterRole: RoleName.PURCHASING,
        idempotencyKey: 'k1',
        body: body(lines),
      });
    await expect(
      run([
        { importShipmentLineId: LINE, quantity: '1.000' },
        { importShipmentLineId: LINE, quantity: '2.000' },
      ]),
    ).rejects.toMatchObject({
      response: {
        code: 'DUPLICATE_SHIPMENT_LINE',
        errors: [{ field: 'lines[1].importShipmentLineId', type: 'BUSINESS' }],
      },
    });
    await expect(
      run([{ importShipmentLineId: LINE, quantity: '0.000' }]),
    ).rejects.toMatchObject({
      response: {
        code: 'QUANTITY_MUST_BE_POSITIVE',
        errors: [{ field: 'lines[0].quantity' }],
      },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rechaza vínculos repetidos en la misma solicitud', async () => {
    await expect(
      service.linkExisting({
        ...base,
        requesterRole: RoleName.PURCHASING,
        idempotencyKey: 'k1',
        body: {
          links: [
            {
              importShipmentLineId: LINE,
              purchaseReceiptLineId: LINE,
              linkedQuantity: '1.000',
            },
            {
              importShipmentLineId: LINE,
              purchaseReceiptLineId: LINE,
              linkedQuantity: '2.000',
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'DUPLICATE_LINK',
        errors: [{ field: 'links[1].purchaseReceiptLineId' }],
      },
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});

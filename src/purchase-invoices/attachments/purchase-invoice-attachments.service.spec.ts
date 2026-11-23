import { ForbiddenException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { makePdf, makePng } from '../../../test/helpers/document-fixtures';
import { PurchaseInvoiceAttachmentsService } from './purchase-invoice-attachments.service';
import type { PurchaseDocumentStorage } from './storage/purchase-document-storage.interface';

/**
 * Validaciones previas a cualquier escritura (rol, contenido, clave de
 * idempotencia): se rechazan SIN tocar almacenamiento ni base de datos. El flujo
 * completo (transacción, compensación, idempotencia concurrente, estados de
 * factura, IDOR) se prueba contra PostgreSQL real en
 * test/r5-purchase-attachments.e2e-spec.ts.
 */
describe('PurchaseInvoiceAttachmentsService (validaciones previas)', () => {
  const save = jest.fn();
  const transaction = jest.fn();
  const storage: PurchaseDocumentStorage = {
    save,
    delete: jest.fn(),
    createReadStream: jest.fn(),
    exists: jest.fn(),
  };
  const prisma = { $transaction: transaction };
  const service = new PurchaseInvoiceAttachmentsService(
    prisma as never,
    {} as never,
    storage,
  );
  const input = {
    purchaseInvoiceId: '11111111-1111-4111-8111-111111111111',
    actorUserId: '22222222-2222-4222-8222-222222222222',
    requesterRole: RoleName.PURCHASING,
  };

  beforeEach(() => jest.clearAllMocks());

  it.each([
    RoleName.SELLER,
    RoleName.WAREHOUSE,
    RoleName.MANAGEMENT,
    RoleName.ACCOUNTANT,
  ])('%s no puede cargar ni eliminar documentos', async (role) => {
    await expect(
      service.upload({
        ...input,
        requesterRole: role,
        file: {
          buffer: makePdf(),
          mimetype: 'application/pdf',
          originalname: 'a.pdf',
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.remove({
        purchaseInvoiceId: input.purchaseInvoiceId,
        attachmentId: input.actorUserId,
        actorUserId: input.actorUserId,
        requesterRole: role,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(save).not.toHaveBeenCalled();
  });

  it.each([RoleName.SELLER, RoleName.WAREHOUSE])(
    '%s no puede consultar ni descargar documentos',
    async (role) => {
      await expect(
        service.list(input.purchaseInvoiceId, role),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.openFile(input.purchaseInvoiceId, input.actorUserId, role),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.listForImportOperation(input.purchaseInvoiceId, role),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('rechaza contenido inválido sin escribir en el almacenamiento', async () => {
    await expect(
      service.upload({
        ...input,
        file: {
          buffer: makePng(),
          mimetype: 'application/pdf',
          originalname: 'a.pdf',
        },
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'ATTACHMENT_MIME_MISMATCH',
        errors: [{ field: 'file' }],
      },
    });
    expect(save).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rechaza una Idempotency-Key con formato inválido', async () => {
    await expect(
      service.upload({
        ...input,
        idempotencyKey: 'clave con espacios!',
        file: {
          buffer: makePdf(),
          mimetype: 'application/pdf',
          originalname: 'a.pdf',
        },
      }),
    ).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_INVALID' },
    });
    expect(save).not.toHaveBeenCalled();
  });
});

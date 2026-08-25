import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { DocumentType, Prisma, RoleName } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { SequenceAdminService } from './sequence-admin.service';

const ACTOR_ID = 'actor-id';
const NOW = new Date('2026-01-01T00:00:00.000Z');

function makeSequenceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sequence-quote-1',
    documentType: DocumentType.QUOTE,
    prefix: 'COT-',
    padding: 6,
    currentNumber: 100,
    updatedAt: NOW,
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>(),
    documentSequence: {
      update: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
  };

  return {
    tx,
    documentSequence: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createAuditServiceMock() {
  return {
    record: jest.fn<Promise<void>, [Record<string, unknown>]>(),
  };
}

describe('SequenceAdminService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: SequenceAdminService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);

    service = new SequenceAdminService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
  });

  describe('listSequences — defensa de rol a nivel de servicio', () => {
    it('ADMIN: devuelve las secuencias ordenadas por documentType ASC', async () => {
      prisma.documentSequence.findMany.mockResolvedValue([
        makeSequenceRow(),
        makeSequenceRow({
          id: 'sequence-sale-1',
          documentType: DocumentType.SALE,
          prefix: 'NV-',
          currentNumber: 50,
        }),
      ]);

      const result = await service.listSequences(RoleName.ADMIN);

      expect(result).toHaveLength(2);
      expect(result[0].documentType).toBe(DocumentType.QUOTE);
      expect(result[1].documentType).toBe(DocumentType.SALE);
      expect(prisma.documentSequence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { documentType: 'asc' } }),
      );
    });

    it('MANAGEMENT: también puede leer', async () => {
      prisma.documentSequence.findMany.mockResolvedValue([makeSequenceRow()]);

      await expect(
        service.listSequences(RoleName.MANAGEMENT),
      ).resolves.toBeDefined();
    });

    it('SELLER: ForbiddenException sin ejecutar ninguna consulta a Prisma', async () => {
      await expect(
        service.listSequences(RoleName.SELLER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.documentSequence.findMany).not.toHaveBeenCalled();
    });

    it('WAREHOUSE: ForbiddenException sin ejecutar ninguna consulta a Prisma', async () => {
      await expect(
        service.listSequences(RoleName.WAREHOUSE),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.documentSequence.findMany).not.toHaveBeenCalled();
    });

    it('rol desconocido: falla cerrado sin ejecutar ninguna consulta a Prisma', async () => {
      await expect(
        service.listSequences('GUEST' as RoleName),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.documentSequence.findMany).not.toHaveBeenCalled();
    });

    it('nunca audita (es una lectura)', async () => {
      prisma.documentSequence.findMany.mockResolvedValue([makeSequenceRow()]);

      await service.listSequences(RoleName.ADMIN);

      expect(auditService.record).not.toHaveBeenCalled();
    });
  });

  describe('updateSequence — defensa de rol a nivel de servicio', () => {
    it('MANAGEMENT: ForbiddenException sin abrir transacción', async () => {
      await expect(
        service.updateSequence({
          documentType: DocumentType.QUOTE,
          prefix: 'Q-',
          actorUserId: ACTOR_ID,
          ipAddress: null,
          requesterRole: RoleName.MANAGEMENT,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('SELLER: ForbiddenException sin abrir transacción', async () => {
      await expect(
        service.updateSequence({
          documentType: DocumentType.QUOTE,
          prefix: 'Q-',
          actorUserId: ACTOR_ID,
          ipAddress: null,
          requesterRole: RoleName.SELLER,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('WAREHOUSE: ForbiddenException sin abrir transacción', async () => {
      await expect(
        service.updateSequence({
          documentType: DocumentType.QUOTE,
          prefix: 'Q-',
          actorUserId: ACTOR_ID,
          ipAddress: null,
          requesterRole: RoleName.WAREHOUSE,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rol desconocido: falla cerrado sin abrir transacción', async () => {
      await expect(
        service.updateSequence({
          documentType: DocumentType.QUOTE,
          prefix: 'Q-',
          actorUserId: ACTOR_ID,
          ipAddress: null,
          requesterRole: 'GUEST' as RoleName,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('updateSequence — validación', () => {
    it('body vacío -> BadRequestException sin abrir transacción', async () => {
      await expect(
        service.updateSequence({
          documentType: DocumentType.QUOTE,
          actorUserId: ACTOR_ID,
          ipAddress: null,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('prefix en blanco tras trim -> BadRequestException sin abrir transacción', async () => {
      await expect(
        service.updateSequence({
          documentType: DocumentType.QUOTE,
          prefix: '   ',
          actorUserId: ACTOR_ID,
          ipAddress: null,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('prefix de más de 10 caracteres tras trim -> BadRequestException', async () => {
      await expect(
        service.updateSequence({
          documentType: DocumentType.QUOTE,
          prefix: '12345678901',
          actorUserId: ACTOR_ID,
          ipAddress: null,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([0, 13])(
      'padding = %d fuera de 1..12 -> BadRequestException',
      async (padding) => {
        await expect(
          service.updateSequence({
            documentType: DocumentType.QUOTE,
            padding,
            actorUserId: ACTOR_ID,
            ipAddress: null,
            requesterRole: RoleName.ADMIN,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('padding no entero (1.5) -> BadRequestException', async () => {
      await expect(
        service.updateSequence({
          documentType: DocumentType.QUOTE,
          padding: 1.5,
          actorUserId: ACTOR_ID,
          ipAddress: null,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('currentNumber negativo -> BadRequestException', async () => {
      await expect(
        service.updateSequence({
          documentType: DocumentType.QUOTE,
          currentNumber: -1,
          actorUserId: ACTOR_ID,
          ipAddress: null,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('currentNumber no entero -> BadRequestException', async () => {
      await expect(
        service.updateSequence({
          documentType: DocumentType.QUOTE,
          currentNumber: 1.5,
          actorUserId: ACTOR_ID,
          ipAddress: null,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('fila de secuencia inexistente -> InternalServerErrorException controlada (nunca 400/404)', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([]);

      await expect(
        service.updateSequence({
          documentType: DocumentType.QUOTE,
          prefix: 'Q-',
          actorUserId: ACTOR_ID,
          ipAddress: null,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(prisma.tx.documentSequence.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });
  });

  describe('updateSequence — bloqueo de fila (SELECT ... FOR UPDATE)', () => {
    it('ejecuta exactamente un $queryRaw con FOR UPDATE y documentType como parámetro vinculado', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([makeSequenceRow()]);
      prisma.tx.documentSequence.update.mockResolvedValue(
        makeSequenceRow({ prefix: 'Q-' }),
      );

      await service.updateSequence({
        documentType: DocumentType.QUOTE,
        prefix: 'Q-',
        actorUserId: ACTOR_ID,
        ipAddress: null,
        requesterRole: RoleName.ADMIN,
      });

      expect(prisma.tx.$queryRaw).toHaveBeenCalledTimes(1);
      const sentQuery = prisma.tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
      expect(sentQuery.sql).toMatch(/FOR UPDATE/);
      expect(sentQuery.sql).not.toContain('QUOTE');
      expect(sentQuery.values).toEqual(['QUOTE']);
    });
  });

  describe('updateSequence — no-op', () => {
    it('mismos prefix/padding/currentNumber -> sin UPDATE, sin auditoría, devuelve el recurso actual', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([makeSequenceRow()]);

      const result = await service.updateSequence({
        documentType: DocumentType.QUOTE,
        prefix: 'COT-',
        padding: 6,
        currentNumber: 100,
        actorUserId: ACTOR_ID,
        ipAddress: null,
        requesterRole: RoleName.ADMIN,
      });

      expect(prisma.tx.documentSequence.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
      expect(result.prefix).toBe('COT-');
      expect(result.currentNumber).toBe(100);
    });

    it('prefix con espacios equivalente al ya persistido tras trim -> no-op', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([makeSequenceRow()]);

      await service.updateSequence({
        documentType: DocumentType.QUOTE,
        prefix: '  COT-  ',
        actorUserId: ACTOR_ID,
        ipAddress: null,
        requesterRole: RoleName.ADMIN,
      });

      expect(prisma.tx.documentSequence.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });
  });

  describe('updateSequence — currentNumber (no-decrease)', () => {
    it('valor mayor: permitido, se actualiza y audita', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([makeSequenceRow()]);
      prisma.tx.documentSequence.update.mockResolvedValue(
        makeSequenceRow({ currentNumber: 500 }),
      );

      const result = await service.updateSequence({
        documentType: DocumentType.QUOTE,
        currentNumber: 500,
        actorUserId: ACTOR_ID,
        ipAddress: null,
        requesterRole: RoleName.ADMIN,
      });

      expect(prisma.tx.documentSequence.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { currentNumber: 500 } }),
      );
      expect(result.currentNumber).toBe(500);
      expect(auditService.record).toHaveBeenCalledTimes(1);
    });

    it('valor igual al bloqueado: no-op (cubierto también arriba), no 409', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([makeSequenceRow()]);

      await expect(
        service.updateSequence({
          documentType: DocumentType.QUOTE,
          currentNumber: 100,
          actorUserId: ACTOR_ID,
          ipAddress: null,
          requesterRole: RoleName.ADMIN,
        }),
      ).resolves.toBeDefined();
    });

    it('valor menor que el bloqueado -> 409, sin UPDATE, sin auditoría', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeSequenceRow({ currentNumber: 100 }),
      ]);

      await expect(
        service.updateSequence({
          documentType: DocumentType.QUOTE,
          currentNumber: 50,
          actorUserId: ACTOR_ID,
          ipAddress: null,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.documentSequence.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('el rechazo compara contra el valor RECIÉN BLOQUEADO, no un valor obsoleto pasado por el llamador', async () => {
      // Simula que, para cuando esta transacción tomó el lock, un next()
      // concurrente ya había avanzado currentNumber a 150 (mayor que lo que
      // el admin solicita). El servicio nunca ve el valor "antiguo": solo
      // conoce lo que devuelve su propio SELECT ... FOR UPDATE.
      prisma.tx.$queryRaw.mockResolvedValue([
        makeSequenceRow({ currentNumber: 150 }),
      ]);

      await expect(
        service.updateSequence({
          documentType: DocumentType.QUOTE,
          currentNumber: 120,
          actorUserId: ACTOR_ID,
          ipAddress: null,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('updateSequence — prefix/padding no sobrescriben currentNumber', () => {
    it('PATCH de solo prefix: el data enviado a Prisma nunca incluye currentNumber', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeSequenceRow({ currentNumber: 101 }),
      ]);
      prisma.tx.documentSequence.update.mockResolvedValue(
        makeSequenceRow({ prefix: 'Q-', currentNumber: 101 }),
      );

      await service.updateSequence({
        documentType: DocumentType.QUOTE,
        prefix: 'Q-',
        actorUserId: ACTOR_ID,
        ipAddress: null,
        requesterRole: RoleName.ADMIN,
      });

      const callArgs = prisma.tx.documentSequence.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(callArgs.data).not.toHaveProperty('currentNumber');
      expect(callArgs.data).toEqual({ prefix: 'Q-' });
    });

    it('PATCH de solo padding: el data enviado a Prisma nunca incluye prefix ni currentNumber', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeSequenceRow({ currentNumber: 101 }),
      ]);
      prisma.tx.documentSequence.update.mockResolvedValue(
        makeSequenceRow({ padding: 8, currentNumber: 101 }),
      );

      await service.updateSequence({
        documentType: DocumentType.QUOTE,
        padding: 8,
        actorUserId: ACTOR_ID,
        ipAddress: null,
        requesterRole: RoleName.ADMIN,
      });

      const callArgs = prisma.tx.documentSequence.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(callArgs.data).toEqual({ padding: 8 });
    });
  });

  describe('updateSequence — PATCH combinado', () => {
    it('prefix + padding + currentNumber cambiados a la vez: un solo UPDATE atómico y una sola auditoría coherente', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([makeSequenceRow()]);
      prisma.tx.documentSequence.update.mockResolvedValue(
        makeSequenceRow({ prefix: 'Q-', padding: 8, currentNumber: 500 }),
      );

      const result = await service.updateSequence({
        documentType: DocumentType.QUOTE,
        prefix: 'Q-',
        padding: 8,
        currentNumber: 500,
        actorUserId: ACTOR_ID,
        ipAddress: null,
        requesterRole: RoleName.ADMIN,
      });

      expect(prisma.tx.documentSequence.update).toHaveBeenCalledTimes(1);
      expect(prisma.tx.documentSequence.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { prefix: 'Q-', padding: 8, currentNumber: 500 },
        }),
      );
      expect(result.prefix).toBe('Q-');
      expect(result.padding).toBe(8);
      expect(result.currentNumber).toBe(500);
      expect(auditService.record).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateSequence — auditoría', () => {
    it('registra SEQUENCE_UPDATED con action/module/entityType/entityId/metadata exactos', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([makeSequenceRow()]);
      prisma.tx.documentSequence.update.mockResolvedValue(
        makeSequenceRow({ prefix: 'Q-', currentNumber: 500 }),
      );

      await service.updateSequence({
        documentType: DocumentType.QUOTE,
        prefix: 'Q-',
        currentNumber: 500,
        actorUserId: ACTOR_ID,
        ipAddress: '10.0.0.1',
        requesterRole: RoleName.ADMIN,
      });

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: ACTOR_ID,
          module: 'CONFIGURATION',
          action: AuditAction.SEQUENCE_UPDATED,
          entityType: 'DocumentSequence',
          entityId: 'sequence-quote-1',
          ipAddress: '10.0.0.1',
          client: prisma.tx,
          metadata: {
            documentType: DocumentType.QUOTE,
            changedFields: ['prefix', 'currentNumber'],
            oldValues: { prefix: 'COT-', currentNumber: 100 },
            newValues: { prefix: 'Q-', currentNumber: 500 },
          },
        }),
      );
    });

    it('un fallo de auditoría revierte toda la operación (la promesa de la transacción se rechaza)', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([makeSequenceRow()]);
      prisma.tx.documentSequence.update.mockResolvedValue(
        makeSequenceRow({ prefix: 'Q-' }),
      );
      auditService.record.mockRejectedValue(new Error('fallo de auditoría'));

      await expect(
        service.updateSequence({
          documentType: DocumentType.QUOTE,
          prefix: 'Q-',
          actorUserId: ACTOR_ID,
          ipAddress: null,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toThrow('fallo de auditoría');
    });
  });
});

import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ConfigurationService } from './configuration.service';

const ACTOR_ID = 'actor-id';
const NOW = new Date('2026-01-01T00:00:00.000Z');

interface CompanySettingsFindUniqueArgs {
  where: { singleton: true };
  select?: Record<string, boolean>;
}
interface CompanySettingsUpdateArgs {
  where: { singleton: true };
  data: Record<string, unknown>;
}

function makeSettingsRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'settings-1',
    businessName: 'Empresa Comercial Demo S.A.C.',
    tradeName: 'Comercial Demo',
    taxId: null,
    address: null,
    phone: null,
    email: null,
    currencyCode: 'PEN',
    currencySymbol: 'S/',
    taxEnabled: false,
    taxRate: new Prisma.Decimal('18.00'),
    quoteValidityDays: 15,
    maxDiscountPercent: new Prisma.Decimal('100.00'),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    companySettings: {
      findUnique: jest.fn<Promise<unknown>, [CompanySettingsFindUniqueArgs]>(),
      update: jest.fn<Promise<unknown>, [CompanySettingsUpdateArgs]>(),
    },
  };

  return {
    tx,
    companySettings: {
      findUnique: jest.fn<Promise<unknown>, [CompanySettingsFindUniqueArgs]>(),
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

describe('ConfigurationService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: ConfigurationService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);

    service = new ConfigurationService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
  });

  describe('getConfiguration — defensa de rol a nivel de servicio', () => {
    it('ADMIN: devuelve la forma segura con Decimal como string de 2 decimales', async () => {
      prisma.companySettings.findUnique.mockResolvedValue(makeSettingsRow());

      const result = await service.getConfiguration(RoleName.ADMIN);

      expect(result.businessName).toBe('Empresa Comercial Demo S.A.C.');
      expect(result.taxRate).toBe('18.00');
      expect(result.maxDiscountPercent).toBe('100.00');
      expect(result.quoteValidityDays).toBe(15);
      expect(result).not.toHaveProperty('singleton');
    });

    it('MANAGEMENT: también puede leer', async () => {
      prisma.companySettings.findUnique.mockResolvedValue(makeSettingsRow());

      await expect(
        service.getConfiguration(RoleName.MANAGEMENT),
      ).resolves.toBeDefined();
    });

    it('SELLER: ForbiddenException sin ejecutar ninguna consulta a Prisma', async () => {
      await expect(
        service.getConfiguration(RoleName.SELLER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.companySettings.findUnique).not.toHaveBeenCalled();
    });

    it('WAREHOUSE: ForbiddenException sin ejecutar ninguna consulta a Prisma', async () => {
      await expect(
        service.getConfiguration(RoleName.WAREHOUSE),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.companySettings.findUnique).not.toHaveBeenCalled();
    });

    it('rol desconocido: falla cerrado sin ejecutar ninguna consulta a Prisma', async () => {
      await expect(
        service.getConfiguration('GUEST' as RoleName),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.companySettings.findUnique).not.toHaveBeenCalled();
    });

    it('lanza InternalServerErrorException si la fila singleton no existe', async () => {
      prisma.companySettings.findUnique.mockResolvedValue(null);

      await expect(
        service.getConfiguration(RoleName.ADMIN),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('getPosConfiguration — Ticket A post-MVP, defensa de rol a nivel de servicio', () => {
    it('ADMIN: devuelve exactamente los 9 campos aprobados, sin datos administrativos', async () => {
      prisma.companySettings.findUnique.mockResolvedValue(makeSettingsRow());

      const result = await service.getPosConfiguration(RoleName.ADMIN);

      expect(result).toEqual({
        businessName: 'Empresa Comercial Demo S.A.C.',
        tradeName: 'Comercial Demo',
        taxId: null,
        address: null,
        currencyCode: 'PEN',
        currencySymbol: 'S/',
        taxEnabled: false,
        taxRate: '18.00',
        maxDiscountPercent: '100.00',
      });
      expect(result).not.toHaveProperty('id');
      expect(result).not.toHaveProperty('phone');
      expect(result).not.toHaveProperty('email');
      expect(result).not.toHaveProperty('quoteValidityDays');
      expect(result).not.toHaveProperty('createdAt');
      expect(result).not.toHaveProperty('updatedAt');
      expect(result).not.toHaveProperty('singleton');
    });

    it('MANAGEMENT: también puede leer', async () => {
      prisma.companySettings.findUnique.mockResolvedValue(makeSettingsRow());

      await expect(
        service.getPosConfiguration(RoleName.MANAGEMENT),
      ).resolves.toBeDefined();
    });

    it('SELLER: también puede leer (a diferencia de getConfiguration)', async () => {
      prisma.companySettings.findUnique.mockResolvedValue(makeSettingsRow());

      await expect(
        service.getPosConfiguration(RoleName.SELLER),
      ).resolves.toBeDefined();
    });

    it('WAREHOUSE: ForbiddenException sin ejecutar ninguna consulta a Prisma', async () => {
      await expect(
        service.getPosConfiguration(RoleName.WAREHOUSE),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.companySettings.findUnique).not.toHaveBeenCalled();
    });

    it('rol desconocido: falla cerrado sin ejecutar ninguna consulta a Prisma', async () => {
      await expect(
        service.getPosConfiguration('GUEST' as RoleName),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.companySettings.findUnique).not.toHaveBeenCalled();
    });

    it('lanza InternalServerErrorException si la fila singleton no existe', async () => {
      prisma.companySettings.findUnique.mockResolvedValue(null);

      await expect(
        service.getPosConfiguration(RoleName.ADMIN),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('nullea tradeName/taxId/address cuando la fila los tiene en null', async () => {
      prisma.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({ tradeName: null, taxId: null, address: null }),
      );

      const result = await service.getPosConfiguration(RoleName.SELLER);

      expect(result.tradeName).toBeNull();
      expect(result.taxId).toBeNull();
      expect(result.address).toBeNull();
    });
  });

  describe('updateConfiguration — defensa de rol a nivel de servicio', () => {
    it('MANAGEMENT: ForbiddenException sin abrir transacción ni consultar Prisma', async () => {
      await expect(
        service.updateConfiguration({
          businessName: 'X',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.MANAGEMENT,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('SELLER: ForbiddenException sin abrir transacción', async () => {
      await expect(
        service.updateConfiguration({
          businessName: 'X',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.SELLER,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('WAREHOUSE: ForbiddenException sin abrir transacción', async () => {
      await expect(
        service.updateConfiguration({
          businessName: 'X',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.WAREHOUSE,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rol desconocido: falla cerrado sin abrir transacción', async () => {
      await expect(
        service.updateConfiguration({
          businessName: 'X',
          actorUserId: ACTOR_ID,
          requesterRole: 'GUEST' as RoleName,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('el chequeo de rol ocurre ANTES que la validación de payload vacío (rol inválido nunca revela detalles de validación)', async () => {
      // Body vacío + rol no autorizado: debe fallar por rol, no por payload.
      await expect(
        service.updateConfiguration({
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.SELLER,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ADMIN con body vacío: BadRequestException, sin abrir transacción', async () => {
      await expect(
        service.updateConfiguration({
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('updateConfiguration — ADMIN, actualización real', () => {
    it('lanza InternalServerErrorException si la fila singleton no existe', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(null);

      await expect(
        service.updateConfiguration({
          businessName: 'Nuevo Nombre',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('actualiza businessName (trim) y registra CONFIGURATION_UPDATED con changedFields/oldValues/newValues', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(makeSettingsRow());
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({ businessName: 'Nuevo Nombre' }),
      );

      const result = await service.updateConfiguration({
        businessName: '  Nuevo Nombre  ',
        actorUserId: ACTOR_ID,
        ipAddress: '10.0.0.1',
        requesterRole: RoleName.ADMIN,
      });

      expect(result.businessName).toBe('Nuevo Nombre');
      const updateArgs = prisma.tx.companySettings.update.mock.calls[0][0];
      expect(updateArgs.data).toEqual({ businessName: 'Nuevo Nombre' });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CONFIGURATION_UPDATED,
          module: 'CONFIGURATION',
          entityType: 'CompanySettings',
          entityId: 'settings-1',
          userId: ACTOR_ID,
          ipAddress: '10.0.0.1',
          metadata: {
            changedFields: ['businessName'],
            oldValues: { businessName: 'Empresa Comercial Demo S.A.C.' },
            newValues: { businessName: 'Nuevo Nombre' },
          },
          client: prisma.tx,
        }),
      );
    });

    it('cambio múltiple: changedFields/oldValues/newValues contienen exactamente los campos cambiados, en el mismo orden', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({ currencyCode: 'PEN', currencySymbol: 'S/' }),
      );
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({ businessName: 'Otro', currencyCode: 'USD' }),
      );

      await service.updateConfiguration({
        businessName: 'Otro',
        currencyCode: 'usd',
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            changedFields: ['businessName', 'currencyCode'],
            oldValues: {
              businessName: 'Empresa Comercial Demo S.A.C.',
              currencyCode: 'PEN',
            },
            newValues: { businessName: 'Otro', currencyCode: 'USD' },
          },
        }),
      );
    });

    it('rechaza businessName en blanco tras el trim', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(makeSettingsRow());

      await expect(
        service.updateConfiguration({
          businessName: '   ',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.companySettings.update).not.toHaveBeenCalled();
    });

    it('tradeName=null limpia el campo existente y audita newValues.tradeName=null', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({ tradeName: 'Algo' }),
      );
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({ tradeName: null }),
      );

      const result = await service.updateConfiguration({
        tradeName: null,
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      expect(result.tradeName).toBeNull();
      const updateArgs = prisma.tx.companySettings.update.mock.calls[0][0];
      expect(updateArgs.data).toEqual({ tradeName: null });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            changedFields: ['tradeName'],
            oldValues: { tradeName: 'Algo' },
            newValues: { tradeName: null },
          },
        }),
      );
    });

    it('tradeName de solo espacios se normaliza a null', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({ tradeName: 'Algo' }),
      );
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({ tradeName: null }),
      );

      await service.updateConfiguration({
        tradeName: '   ',
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      const updateArgs = prisma.tx.companySettings.update.mock.calls[0][0];
      expect(updateArgs.data).toEqual({ tradeName: null });
    });

    it('normaliza currencyCode a mayúsculas', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(makeSettingsRow());
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({ currencyCode: 'USD' }),
      );

      await service.updateConfiguration({
        currencyCode: 'usd',
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      const updateArgs = prisma.tx.companySettings.update.mock.calls[0][0];
      expect(updateArgs.data).toEqual({ currencyCode: 'USD' });
    });

    it('rechaza currencyCode con formato inválido', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(makeSettingsRow());

      await expect(
        service.updateConfiguration({
          currencyCode: 'PE1',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.companySettings.update).not.toHaveBeenCalled();
    });

    it('rechaza currencySymbol en blanco tras el trim', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(makeSettingsRow());

      await expect(
        service.updateConfiguration({
          currencySymbol: '   ',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.companySettings.update).not.toHaveBeenCalled();
    });

    it('no-op: valores normalizados idénticos a los actuales -> sin update ni auditoría (200)', async () => {
      const existing = makeSettingsRow({ currencyCode: 'PEN' });
      prisma.tx.companySettings.findUnique.mockResolvedValue(existing);

      const result = await service.updateConfiguration({
        businessName: existing.businessName,
        currencyCode: 'pen',
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      expect(result.currencyCode).toBe('PEN');
      expect(prisma.tx.companySettings.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('revierte la operación si la auditoría falla (transacción simulada)', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(makeSettingsRow());
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({ businessName: 'Otro' }),
      );
      auditService.record.mockRejectedValue(new Error('fallo de auditoría'));

      await expect(
        service.updateConfiguration({
          businessName: 'Otro',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toThrow('fallo de auditoría');
      expect(prisma.tx.companySettings.update).toHaveBeenCalledTimes(1);
    });

    it('la metadata de auditoría nunca contiene singleton/id/createdAt/updatedAt ni los campos aún bloqueados del Bloque A', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(makeSettingsRow());
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({ businessName: 'Otro' }),
      );

      await service.updateConfiguration({
        businessName: 'Otro',
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      const call = auditService.record.mock.calls[0][0] as {
        metadata: { oldValues: object; newValues: object };
      };
      const serialized = JSON.stringify(call.metadata);
      for (const forbidden of [
        'singleton',
        '"id"',
        'createdAt',
        'updatedAt',
        'taxEnabled',
        'taxRate',
        'quoteValidityDays',
        'maxDiscountPercent',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  });

  describe('updateConfiguration — Bloque B (quoteValidityDays/maxDiscountPercent)', () => {
    it('ADMIN puede actualizar quoteValidityDays y registra CONFIGURATION_UPDATED con valores enteros', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({ quoteValidityDays: 15 }),
      );
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({ quoteValidityDays: 30 }),
      );

      const result = await service.updateConfiguration({
        quoteValidityDays: 30,
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      expect(result.quoteValidityDays).toBe(30);
      const updateArgs = prisma.tx.companySettings.update.mock.calls[0][0];
      expect(updateArgs.data).toEqual({ quoteValidityDays: 30 });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CONFIGURATION_UPDATED,
          metadata: {
            changedFields: ['quoteValidityDays'],
            oldValues: { quoteValidityDays: 15 },
            newValues: { quoteValidityDays: 30 },
          },
        }),
      );
    });

    it('rechaza quoteValidityDays = 0', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(makeSettingsRow());

      await expect(
        service.updateConfiguration({
          quoteValidityDays: 0,
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.companySettings.update).not.toHaveBeenCalled();
    });

    it('rechaza quoteValidityDays negativo', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(makeSettingsRow());

      await expect(
        service.updateConfiguration({
          quoteValidityDays: -5,
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.companySettings.update).not.toHaveBeenCalled();
    });

    it('rechaza quoteValidityDays no entero', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(makeSettingsRow());

      await expect(
        service.updateConfiguration({
          quoteValidityDays: 15.5,
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('quoteValidityDays no-op (mismo valor ya vigente): sin update ni auditoría', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({ quoteValidityDays: 15 }),
      );

      const result = await service.updateConfiguration({
        quoteValidityDays: 15,
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      expect(result.quoteValidityDays).toBe(15);
      expect(prisma.tx.companySettings.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('acepta maxDiscountPercent = 0.00 (sin descuento permitido)', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({ maxDiscountPercent: new Prisma.Decimal('100.00') }),
      );
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({ maxDiscountPercent: new Prisma.Decimal('0.00') }),
      );

      const result = await service.updateConfiguration({
        maxDiscountPercent: '0.00',
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      expect(result.maxDiscountPercent).toBe('0.00');
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            changedFields: ['maxDiscountPercent'],
            oldValues: { maxDiscountPercent: '100.00' },
            newValues: { maxDiscountPercent: '0.00' },
          },
        }),
      );
    });

    it('acepta maxDiscountPercent = 100.00 (descuento total permitido)', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({ maxDiscountPercent: new Prisma.Decimal('10.00') }),
      );
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({ maxDiscountPercent: new Prisma.Decimal('100.00') }),
      );

      const result = await service.updateConfiguration({
        maxDiscountPercent: '100.00',
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      expect(result.maxDiscountPercent).toBe('100.00');
    });

    it('acepta un valor Decimal intermedio', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({ maxDiscountPercent: new Prisma.Decimal('100.00') }),
      );
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({ maxDiscountPercent: new Prisma.Decimal('33.33') }),
      );

      const result = await service.updateConfiguration({
        maxDiscountPercent: '33.33',
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      expect(result.maxDiscountPercent).toBe('33.33');
    });

    it('rechaza maxDiscountPercent negativo', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(makeSettingsRow());

      await expect(
        service.updateConfiguration({
          maxDiscountPercent: '-1.00',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.companySettings.update).not.toHaveBeenCalled();
    });

    it('rechaza maxDiscountPercent > 100', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(makeSettingsRow());

      await expect(
        service.updateConfiguration({
          maxDiscountPercent: '100.01',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.companySettings.update).not.toHaveBeenCalled();
    });

    it('rechaza maxDiscountPercent con formato inválido (más de 2 decimales)', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(makeSettingsRow());

      await expect(
        service.updateConfiguration({
          maxDiscountPercent: '10.123',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('maxDiscountPercent no-op (mismo valor normalizado ya vigente): sin update ni auditoría', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({ maxDiscountPercent: new Prisma.Decimal('100.00') }),
      );

      const result = await service.updateConfiguration({
        maxDiscountPercent: '100.00',
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      expect(result.maxDiscountPercent).toBe('100.00');
      expect(prisma.tx.companySettings.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('cambia ambos campos del Bloque B en un solo PATCH: changedFields/oldValues/newValues exactos', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({
          quoteValidityDays: 15,
          maxDiscountPercent: new Prisma.Decimal('100.00'),
        }),
      );
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({
          quoteValidityDays: 30,
          maxDiscountPercent: new Prisma.Decimal('10.00'),
        }),
      );

      await service.updateConfiguration({
        quoteValidityDays: 30,
        maxDiscountPercent: '10.00',
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            changedFields: ['quoteValidityDays', 'maxDiscountPercent'],
            oldValues: { quoteValidityDays: 15, maxDiscountPercent: '100.00' },
            newValues: { quoteValidityDays: 30, maxDiscountPercent: '10.00' },
          },
        }),
      );
    });
  });

  describe('updateConfiguration — Bloque C (taxEnabled/taxRate)', () => {
    it('ADMIN puede activar taxEnabled y registra CONFIGURATION_UPDATED con boolean old/new', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({
          taxEnabled: false,
          taxRate: new Prisma.Decimal('18.00'),
        }),
      );
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({ taxEnabled: true }),
      );

      const result = await service.updateConfiguration({
        taxEnabled: true,
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      expect(result.taxEnabled).toBe(true);
      const updateArgs = prisma.tx.companySettings.update.mock.calls[0][0];
      expect(updateArgs.data).toEqual({ taxEnabled: true });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CONFIGURATION_UPDATED,
          metadata: {
            changedFields: ['taxEnabled'],
            oldValues: { taxEnabled: false },
            newValues: { taxEnabled: true },
          },
        }),
      );
    });

    it('rechaza activar taxEnabled cuando el taxRate YA vigente es 0.00 (invariante sobre el estado resultante)', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({
          taxEnabled: false,
          taxRate: new Prisma.Decimal('0.00'),
        }),
      );

      await expect(
        service.updateConfiguration({
          taxEnabled: true,
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.companySettings.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('rechaza poner taxRate=0.00 cuando taxEnabled YA está activo (invariante sobre el estado resultante)', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({
          taxEnabled: true,
          taxRate: new Prisma.Decimal('18.00'),
        }),
      );

      await expect(
        service.updateConfiguration({
          taxRate: '0.00',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.companySettings.update).not.toHaveBeenCalled();
    });

    it('permite desactivar taxEnabled Y poner taxRate=0.00 en el mismo PATCH', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({
          taxEnabled: true,
          taxRate: new Prisma.Decimal('18.00'),
        }),
      );
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({
          taxEnabled: false,
          taxRate: new Prisma.Decimal('0.00'),
        }),
      );

      const result = await service.updateConfiguration({
        taxEnabled: false,
        taxRate: '0.00',
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      expect(result.taxEnabled).toBe(false);
      expect(result.taxRate).toBe('0.00');
    });

    it('permite activar taxEnabled cuando el taxRate YA vigente es > 0 (sin tocar taxRate en el mismo PATCH)', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({
          taxEnabled: false,
          taxRate: new Prisma.Decimal('18.00'),
        }),
      );
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({ taxEnabled: true }),
      );

      await expect(
        service.updateConfiguration({
          taxEnabled: true,
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).resolves.toBeDefined();
    });

    it('acepta taxRate=100.00 cuando taxEnabled resultante es true', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({
          taxEnabled: true,
          taxRate: new Prisma.Decimal('18.00'),
        }),
      );
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({ taxRate: new Prisma.Decimal('100.00') }),
      );

      const result = await service.updateConfiguration({
        taxRate: '100.00',
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      expect(result.taxRate).toBe('100.00');
    });

    it('rechaza taxRate negativo', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({ taxEnabled: false }),
      );

      await expect(
        service.updateConfiguration({
          taxRate: '-1.00',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza taxRate > 100', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({ taxEnabled: false }),
      );

      await expect(
        service.updateConfiguration({
          taxRate: '100.01',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza taxRate con formato inválido (más de 2 decimales)', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({ taxEnabled: false }),
      );

      await expect(
        service.updateConfiguration({
          taxRate: '18.123',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('acepta taxRate=0.00 cuando taxEnabled resultante (ya vigente) es false', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({
          taxEnabled: false,
          taxRate: new Prisma.Decimal('18.00'),
        }),
      );
      prisma.tx.companySettings.update.mockResolvedValue(
        makeSettingsRow({ taxRate: new Prisma.Decimal('0.00') }),
      );

      await expect(
        service.updateConfiguration({
          taxRate: '0.00',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).resolves.toBeDefined();
    });

    it('taxEnabled no-op (mismo valor ya vigente): sin update ni auditoría', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({ taxEnabled: false }),
      );

      const result = await service.updateConfiguration({
        taxEnabled: false,
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      expect(result.taxEnabled).toBe(false);
      expect(prisma.tx.companySettings.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('taxRate no-op (mismo valor normalizado ya vigente): sin update ni auditoría', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({ taxRate: new Prisma.Decimal('18.00') }),
      );

      const result = await service.updateConfiguration({
        taxRate: '18.00',
        actorUserId: ACTOR_ID,
        requesterRole: RoleName.ADMIN,
      });

      expect(result.taxRate).toBe('18.00');
      expect(prisma.tx.companySettings.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('rechazo por invariante cruzada no genera UPDATE ni auditoría (ambos verificados)', async () => {
      prisma.tx.companySettings.findUnique.mockResolvedValue(
        makeSettingsRow({
          taxEnabled: true,
          taxRate: new Prisma.Decimal('18.00'),
        }),
      );

      await expect(
        service.updateConfiguration({
          taxRate: '0.00',
          actorUserId: ACTOR_ID,
          requesterRole: RoleName.ADMIN,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.companySettings.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });
  });
});

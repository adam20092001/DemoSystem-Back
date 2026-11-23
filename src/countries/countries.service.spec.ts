import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { CountriesService } from './countries.service';

const ACTOR = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-23T00:00:00.000Z');

function row(code = 'BR', overrides: Record<string, unknown> = {}) {
  return {
    code,
    name: 'Brasil',
    active: true,
    pendingReview: false,
    createdByUserId: ACTOR,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function setup() {
  const tx = {
    country: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma = {
    country: {
      findMany: jest.fn().mockResolvedValue([row()]),
      findUnique: jest.fn(),
    },
    $transaction: jest.fn((cb: (c: typeof tx) => unknown) => cb(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new CountriesService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { tx, prisma, audit, service };
}

const base = { actorUserId: ACTOR, ipAddress: null };

describe('CountriesService (R4)', () => {
  it.each([
    RoleName.ADMIN,
    RoleName.MANAGEMENT,
    RoleName.ACCOUNTANT,
    RoleName.PURCHASING,
    RoleName.WAREHOUSE,
    RoleName.SELLER,
  ])('%s puede consultar', async (role) => {
    const { service } = setup();
    await expect(service.list({}, role)).resolves.toHaveLength(1);
  });

  it('por defecto solo lista países activos; includeInactive los incluye', async () => {
    const { service, prisma } = setup();
    await service.list({}, RoleName.ADMIN);
    expect(prisma.country.findMany.mock.calls[0][0].where).toEqual({
      active: true,
    });
    await service.list({ includeInactive: true }, RoleName.ADMIN);
    expect(prisma.country.findMany.mock.calls[1][0].where).toEqual({});
  });

  it('ADMIN y PURCHASING registran países; los demás roles reciben 403', async () => {
    for (const role of [RoleName.ADMIN, RoleName.PURCHASING]) {
      const { service, tx, audit } = setup();
      tx.country.findUnique.mockResolvedValue(null);
      tx.country.create.mockResolvedValue(row());
      await expect(
        service.create({
          ...base,
          requesterRole: role,
          code: 'br',
          name: ' Brasil ',
        }),
      ).resolves.toMatchObject({ code: 'BR' });
      expect(tx.country.create.mock.calls[0][0].data).toMatchObject({
        code: 'BR',
        name: 'Brasil',
        createdByUserId: ACTOR,
      });
      expect(audit.record).toHaveBeenCalledTimes(1);
    }
    for (const role of [
      RoleName.MANAGEMENT,
      RoleName.ACCOUNTANT,
      RoleName.WAREHOUSE,
      RoleName.SELLER,
    ]) {
      const { service } = setup();
      await expect(
        service.create({
          ...base,
          requesterRole: role,
          code: 'BR',
          name: 'Brasil',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('PURCHASING no edita ni activa/desactiva países (solo ADMIN)', async () => {
    const { service } = setup();
    await expect(
      service.update({
        ...base,
        requesterRole: RoleName.PURCHASING,
        code: 'CN',
        name: 'X',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.setActive({
        ...base,
        requesterRole: RoleName.PURCHASING,
        code: 'CN',
        active: false,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('código duplicado: 409 sin crear; formato inválido: 400', async () => {
    const { service, tx } = setup();
    tx.country.findUnique.mockResolvedValue({ code: 'CN' });
    await expect(
      service.create({
        ...base,
        requesterRole: RoleName.ADMIN,
        code: 'CN',
        name: 'China 2',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.country.create).not.toHaveBeenCalled();
    await expect(
      service.create({
        ...base,
        requesterRole: RoleName.ADMIN,
        code: 'CHN',
        name: 'China',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('nombre duplicado (sin distinguir mayúsculas): 409', async () => {
    const { service, tx } = setup();
    tx.country.findUnique.mockResolvedValue(null);
    tx.$queryRaw.mockResolvedValueOnce([{ code: 'CN' }]);
    await expect(
      service.create({
        ...base,
        requesterRole: RoleName.ADMIN,
        code: 'ZZ',
        name: 'china',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('desactivar: 404 si no existe y 409 si ya está inactivo; nunca existe un borrado', async () => {
    const { service, tx } = setup();
    tx.$queryRaw.mockResolvedValueOnce([]);
    await expect(
      service.setActive({
        ...base,
        requesterRole: RoleName.ADMIN,
        code: 'ZZ',
        active: false,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    tx.$queryRaw.mockResolvedValueOnce([{ active: false }]);
    await expect(
      service.setActive({
        ...base,
        requesterRole: RoleName.ADMIN,
        code: 'CN',
        active: false,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect('delete' in service).toBe(false);
  });

  it('pendingReview solo puede confirmarse (false)', async () => {
    const { service } = setup();
    await expect(
      service.update({
        ...base,
        requesterRole: RoleName.ADMIN,
        code: 'CN',
        pendingReview: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

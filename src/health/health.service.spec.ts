import { Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { HealthService } from './health.service';

describe('HealthService', () => {
  let queryRaw: jest.Mock;
  let service: HealthService;

  beforeEach(() => {
    queryRaw = jest.fn();
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
    service = new HealthService(prisma);

    // El fallo de base de datos se registra; se silencia para no ensuciar la salida.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('con base de datos disponible', () => {
    beforeEach(() => {
      queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    });

    it('reporta estado global ok y base de datos up', async () => {
      const result = await service.check();

      expect(result.status).toBe('ok');
      expect(result.application).toBe('up');
      expect(result.database).toBe('up');
    });

    it('incluye uptime numérico y timestamp ISO', async () => {
      const result = await service.check();

      expect(typeof result.uptime).toBe('number');
      expect(result.uptime).toBeGreaterThanOrEqual(0);
      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
    });

    it('consulta la base de datos exactamente una vez', async () => {
      await service.check();

      expect(queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('con fallo de base de datos', () => {
    beforeEach(() => {
      queryRaw.mockRejectedValue(
        new Error(
          'connect ECONNREFUSED 127.0.0.1:5432 — password authentication failed for user "pos_user"',
        ),
      );
    });

    it('reporta estado global error y base de datos down sin lanzar excepción', async () => {
      const result = await service.check();

      expect(result.status).toBe('error');
      expect(result.database).toBe('down');
    });

    it('mantiene la aplicación como up', async () => {
      const result = await service.check();

      expect(result.application).toBe('up');
    });

    it('no filtra credenciales ni mensajes internos de PostgreSQL', async () => {
      const result = await service.check();
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain('pos_user');
      expect(serialized).not.toContain('5432');
      expect(serialized).not.toContain('ECONNREFUSED');
      expect(serialized).not.toContain('password');
      expect(Object.keys(result).sort()).toEqual([
        'application',
        'database',
        'status',
        'timestamp',
        'uptime',
      ]);
    });
  });
});

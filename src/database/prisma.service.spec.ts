import { Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  let service: PrismaService;
  let connect: jest.SpyInstance;
  let disconnect: jest.SpyInstance;

  beforeEach(() => {
    service = new PrismaService();
    connect = jest.spyOn(service, '$connect').mockResolvedValue(undefined);
    disconnect = jest
      .spyOn(service, '$disconnect')
      .mockResolvedValue(undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('abre la conexión en onModuleInit', async () => {
    await service.onModuleInit();

    expect(connect).toHaveBeenCalledTimes(1);
  });

  // Respalda el apagado ordenado que dispara app.enableShutdownHooks().
  it('cierra la conexión en onModuleDestroy', async () => {
    await service.onModuleDestroy();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

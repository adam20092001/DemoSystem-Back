import { InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { SettingsReader } from './settings-reader.service';

interface CompanySettingsFindUniqueArgs {
  where: { singleton: true };
  select?: Record<string, boolean>;
}

function makeSnapshotRow() {
  return {
    currencyCode: 'PEN',
    currencySymbol: 'S/',
    taxEnabled: false,
    taxRate: new Prisma.Decimal('18.00'),
    quoteValidityDays: 15,
    maxDiscountPercent: new Prisma.Decimal('100.00'),
  };
}

function createPrismaMock() {
  return {
    companySettings: {
      findUnique: jest.fn<Promise<unknown>, [CompanySettingsFindUniqueArgs]>(),
    },
  };
}

describe('SettingsReader', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let reader: SettingsReader;

  beforeEach(() => {
    prisma = createPrismaMock();
    reader = new SettingsReader(prisma as unknown as PrismaService);
  });

  it('devuelve el snapshot con Decimal intacto (sin convertir a string)', async () => {
    prisma.companySettings.findUnique.mockResolvedValue(makeSnapshotRow());

    const result = await reader.getCurrent();

    expect(result.currencyCode).toBe('PEN');
    expect(result.taxRate).toBeInstanceOf(Prisma.Decimal);
    expect(result.taxRate.toFixed(2)).toBe('18.00');
    expect(result.maxDiscountPercent).toBeInstanceOf(Prisma.Decimal);
  });

  it('consulta por singleton: true y solo los 6 campos de negocio', async () => {
    prisma.companySettings.findUnique.mockResolvedValue(makeSnapshotRow());

    await reader.getCurrent();

    const args = prisma.companySettings.findUnique.mock.calls[0][0];
    expect(args.where).toEqual({ singleton: true });
    expect(args.select).toEqual({
      currencyCode: true,
      currencySymbol: true,
      taxEnabled: true,
      taxRate: true,
      quoteValidityDays: true,
      maxDiscountPercent: true,
    });
  });

  it('lanza InternalServerErrorException si la fila singleton no existe', async () => {
    prisma.companySettings.findUnique.mockResolvedValue(null);

    await expect(reader.getCurrent()).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('usa el cliente de transacción recibido en vez de this.prisma', async () => {
    const txFindUnique = jest.fn().mockResolvedValue(makeSnapshotRow());
    const tx = { companySettings: { findUnique: txFindUnique } };

    await reader.getCurrent(tx as never);

    expect(txFindUnique).toHaveBeenCalledTimes(1);
    expect(prisma.companySettings.findUnique).not.toHaveBeenCalled();
  });
});

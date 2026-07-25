import { PasswordService } from './password.service';

describe('PasswordService', () => {
  let service: PasswordService;

  beforeEach(() => {
    service = new PasswordService();
  });

  it('genera un hash con formato Argon2id', async () => {
    const hash = await service.hash('SuperSecreta123');

    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('verifica correctamente la contraseña original', async () => {
    const hash = await service.hash('SuperSecreta123');

    await expect(service.verify(hash, 'SuperSecreta123')).resolves.toBe(true);
  });

  it('rechaza una contraseña incorrecta', async () => {
    const hash = await service.hash('SuperSecreta123');

    await expect(service.verify(hash, 'OtraDistinta456')).resolves.toBe(false);
  });

  it('genera hashes distintos para la misma contraseña por el salt aleatorio', async () => {
    const hashA = await service.hash('SuperSecreta123');
    const hashB = await service.hash('SuperSecreta123');

    expect(hashA).not.toBe(hashB);
    await expect(service.verify(hashA, 'SuperSecreta123')).resolves.toBe(true);
    await expect(service.verify(hashB, 'SuperSecreta123')).resolves.toBe(true);
  });
});

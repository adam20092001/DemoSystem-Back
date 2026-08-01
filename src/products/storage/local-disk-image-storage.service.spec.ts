import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvironmentVariables } from '../../config/env.validation';
import { LocalDiskImageStorageService } from './local-disk-image-storage.service';

function createConfigServiceMock(rootDir: string) {
  return {
    get: jest.fn(() => rootDir),
  };
}

async function readStreamToBuffer(
  stream: NodeJS.ReadableStream,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe('LocalDiskImageStorageService', () => {
  let rootDir: string;
  let service: LocalDiskImageStorageService;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'demosystem-storage-spec-'));
    const configService = createConfigServiceMock(rootDir);
    service = new LocalDiskImageStorageService(
      configService as unknown as ConfigService<EnvironmentVariables, true>,
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('guarda el archivo bajo el directorio configurado, creando subdirectorios', async () => {
    const productId = randomUUID();
    const buffer = Buffer.from('contenido de prueba');

    const saved = await service.save({ productId, buffer, extension: 'jpg' });

    expect(saved.storagePath.startsWith(productId)).toBe(true);
    expect(saved.storagePath.endsWith('.jpg')).toBe(true);

    const stats = await stat(join(rootDir, saved.storagePath));
    expect(stats.isFile()).toBe(true);
  });

  it('genera un nombre físico propio (UUID), nunca a partir del nombre original', async () => {
    const productId = randomUUID();
    const buffer = Buffer.from('a');

    const saved = await service.save({ productId, buffer, extension: 'png' });
    const fileNamePart = saved.storagePath.split(/[/\\]/)[1];

    expect(fileNamePart).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/,
    );
  });

  it('crea el directorio del producto si no existe todavía', async () => {
    const productId = randomUUID();
    const entriesBefore = await readdir(rootDir).catch(() => []);
    expect(entriesBefore).not.toContain(productId);

    await service.save({
      productId,
      buffer: Buffer.from('x'),
      extension: 'webp',
    });

    const entriesAfter = await readdir(rootDir);
    expect(entriesAfter).toContain(productId);
  });

  it('evita path traversal en storagePath', async () => {
    await expect(service.exists('../../etc/passwd')).rejects.toThrow(
      /fuera del directorio raíz/,
    );
  });

  it('abre un stream de lectura con el contenido guardado', async () => {
    const productId = randomUUID();
    const content = 'contenido a leer';
    const saved = await service.save({
      productId,
      buffer: Buffer.from(content),
      extension: 'jpg',
    });

    const stream = service.createReadStream(saved.storagePath);
    const readBuffer = await readStreamToBuffer(stream);

    expect(readBuffer.toString()).toBe(content);
  });

  it('elimina un archivo existente', async () => {
    const productId = randomUUID();
    const saved = await service.save({
      productId,
      buffer: Buffer.from('a eliminar'),
      extension: 'png',
    });

    await service.delete(saved.storagePath);

    await expect(service.exists(saved.storagePath)).resolves.toBe(false);
  });

  it('delete() no lanza si el archivo ya no existe', async () => {
    const productId = randomUUID();
    const missingPath = join(productId, `${randomUUID()}.jpg`);

    await expect(service.delete(missingPath)).resolves.toBeUndefined();
  });

  it('exists() distingue un archivo inexistente de uno existente', async () => {
    const productId = randomUUID();
    const saved = await service.save({
      productId,
      buffer: Buffer.from('existe'),
      extension: 'jpg',
    });

    await expect(service.exists(saved.storagePath)).resolves.toBe(true);
    await expect(
      service.exists(join(productId, `${randomUUID()}.jpg`)),
    ).resolves.toBe(false);
  });
});

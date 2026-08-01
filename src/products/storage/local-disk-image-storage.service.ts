import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createReadStream, ReadStream } from 'node:fs';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { EnvironmentVariables } from '../../config/env.validation';
import {
  ImageStorage,
  SaveImageInput,
  SavedImage,
} from './image-storage.interface';

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/**
 * Implementación en disco local de ImageStorage. Guarda bajo
 * <PRODUCT_UPLOAD_DIR>/<productId>/<uuid>.<extension> — el nombre físico lo
 * genera siempre el backend, nunca a partir del nombre original del cliente.
 */
@Injectable()
export class LocalDiskImageStorageService implements ImageStorage {
  private readonly rootDir: string;

  constructor(configService: ConfigService<EnvironmentVariables, true>) {
    this.rootDir = resolve(
      configService.get('PRODUCT_UPLOAD_DIR', { infer: true }),
    );
  }

  async save(input: SaveImageInput): Promise<SavedImage> {
    const storagePath = join(
      input.productId,
      `${randomUUID()}.${input.extension}`,
    );
    const absolutePath = this.resolveWithinRoot(storagePath);

    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.buffer);

    return { storagePath };
  }

  async delete(storagePath: string): Promise<void> {
    const absolutePath = this.resolveWithinRoot(storagePath);
    try {
      await unlink(absolutePath);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  createReadStream(storagePath: string): ReadStream {
    const absolutePath = this.resolveWithinRoot(storagePath);
    return createReadStream(absolutePath);
  }

  async exists(storagePath: string): Promise<boolean> {
    const absolutePath = this.resolveWithinRoot(storagePath);
    try {
      await access(absolutePath);
      return true;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Resuelve storagePath contra la raíz configurada y rechaza cualquier
   * resultado que escape de ella (path traversal), sin importar si el valor
   * proviene de un dato recién generado o de una fila leída de BD.
   */
  private resolveWithinRoot(storagePath: string): string {
    const absolutePath = resolve(this.rootDir, storagePath);
    const rootWithSep = this.rootDir.endsWith(sep)
      ? this.rootDir
      : this.rootDir + sep;
    if (
      absolutePath !== this.rootDir &&
      !absolutePath.startsWith(rootWithSep)
    ) {
      throw new Error(
        'Ruta de almacenamiento fuera del directorio raíz permitido',
      );
    }
    return absolutePath;
  }
}

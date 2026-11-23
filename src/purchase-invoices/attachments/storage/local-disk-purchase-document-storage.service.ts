import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { EnvironmentVariables } from '../../../config/env.validation';
import {
  PurchaseDocumentStorage,
  SavedPurchaseDocument,
  SavePurchaseDocumentInput,
} from './purchase-document-storage.interface';

const ALLOWED_EXTENSIONS = new Set(['pdf', 'jpg', 'png']);

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/**
 * Almacenamiento en disco local PRIVADO (raíz = PURCHASE_DOCUMENTS_DIR).
 * Clave física: <2 hex>/<64 hex aleatorios>.<ext> — 256 bits de aleatoriedad,
 * nunca el nombre del cliente. La escritura es atómica (archivo temporal en la
 * misma carpeta + rename): un fallo a mitad nunca deja un archivo parcial bajo
 * su clave definitiva. Permisos 0600/0700 (solo el usuario del proceso).
 */
@Injectable()
export class LocalDiskPurchaseDocumentStorageService implements PurchaseDocumentStorage {
  private readonly rootDir: string;

  constructor(configService: ConfigService<EnvironmentVariables, true>) {
    this.rootDir = resolve(
      configService.get('PURCHASE_DOCUMENTS_DIR', { infer: true }),
    );
  }

  async save(input: SavePurchaseDocumentInput): Promise<SavedPurchaseDocument> {
    if (!ALLOWED_EXTENSIONS.has(input.extension)) {
      throw new Error('Extensión de almacenamiento no permitida');
    }
    const token = randomBytes(32).toString('hex');
    const storageKey = `${token.slice(0, 2)}/${token}.${input.extension}`;
    const absolutePath = this.resolveWithinRoot(storageKey);
    const tempPath = `${absolutePath}.tmp-${randomBytes(6).toString('hex')}`;

    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(tempPath, input.buffer, { mode: 0o600, flag: 'wx' });
      await rename(tempPath, absolutePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
    return { storageKey };
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await unlink(this.resolveWithinRoot(storageKey));
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  createReadStream(storageKey: string): Readable {
    return createReadStream(this.resolveWithinRoot(storageKey));
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      await access(this.resolveWithinRoot(storageKey));
      return true;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /** Rechaza cualquier clave que escape de la raíz (path traversal), venga de donde venga. */
  private resolveWithinRoot(storageKey: string): string {
    const absolutePath = resolve(this.rootDir, storageKey);
    const rootWithSep = this.rootDir.endsWith(sep)
      ? this.rootDir
      : this.rootDir + sep;
    if (!absolutePath.startsWith(rootWithSep)) {
      throw new Error(
        'Clave de almacenamiento fuera del directorio raíz permitido',
      );
    }
    return absolutePath;
  }
}

import { Injectable } from '@nestjs/common';
import { argon2id, hash, HashOptions, verify } from 'argon2';

/**
 * Parámetros Argon2id acordados para la Fase 1 (mínimos recomendados por OWASP).
 * Se exportan para que prisma/seed.ts hashee con la misma configuración sin
 * duplicarla ni depender de instanciar el servicio de Nest fuera de un módulo.
 */
export const ARGON2_OPTIONS: HashOptions = {
  type: argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/** Hashea una contraseña con los parámetros Argon2id de la Fase 1. */
export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** Verifica una contraseña contra un hash Argon2id previamente generado. */
export function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  return verify(passwordHash, password);
}

@Injectable()
export class PasswordService {
  hash(password: string): Promise<string> {
    return hashPassword(password);
  }

  verify(passwordHash: string, password: string): Promise<boolean> {
    return verifyPassword(passwordHash, password);
  }
}

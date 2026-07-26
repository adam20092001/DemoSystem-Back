import request from 'supertest';
import { App } from 'supertest/types';

export interface LoginResult {
  status: number;
  body: Record<string, unknown>;
  setCookieHeader: string;
  /** Solo "nombre=valor", listo para enviarse en la cabecera Cookie de otra request. */
  cookie: string;
}

export async function login(
  app: App,
  identifier: string,
  password: string,
): Promise<LoginResult> {
  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ identifier, password });

  const setCookie = (response.headers['set-cookie'] ?? []) as string[];
  const setCookieHeader = setCookie[0] ?? '';
  const cookie = setCookieHeader.split(';')[0] ?? '';

  return {
    status: response.status,
    body: response.body as Record<string, unknown>,
    setCookieHeader,
    cookie,
  };
}

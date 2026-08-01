import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';

interface CapturedResponse {
  statusCode?: number;
  body?: Record<string, unknown>;
}

interface FakeResponse {
  status: (code: number) => FakeResponse;
  json: (body: Record<string, unknown>) => void;
}

function createHost(captured: CapturedResponse): ArgumentsHost {
  const response: FakeResponse = {
    status: (code: number): FakeResponse => {
      captured.statusCode = code;
      return response;
    },
    json: (body: Record<string, unknown>): void => {
      captured.body = body;
    },
  };
  const request = { url: '/api/v1/auth/login' };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
  });

  it('conserva code cuando la excepción lo incluye (p. ej. ACCOUNT_BLOCKED)', () => {
    const captured: CapturedResponse = {};
    const exception = new HttpException(
      { message: 'La cuenta se encuentra bloqueada.', code: 'ACCOUNT_BLOCKED' },
      HttpStatus.LOCKED,
    );

    filter.catch(exception, createHost(captured));

    expect(captured.statusCode).toBe(423);
    expect(captured.body).toEqual(
      expect.objectContaining({
        statusCode: 423,
        message: 'La cuenta se encuentra bloqueada.',
        error: 'Locked',
        code: 'ACCOUNT_BLOCKED',
      }),
    );
  });

  it('no agrega la propiedad code a excepciones que no la incluyen', () => {
    const captured: CapturedResponse = {};
    const exception = new NotFoundException('El recurso no existe');

    filter.catch(exception, createHost(captured));

    expect(captured.body).not.toHaveProperty('code');
  });

  it('mantiene la estructura estándar de la respuesta (statusCode, message, error, timestamp, path)', () => {
    const captured: CapturedResponse = {};
    const exception = new BadRequestException('Payload inválido');

    filter.catch(exception, createHost(captured));

    expect(captured.body).toEqual(
      expect.objectContaining({
        statusCode: 400,
        message: 'Payload inválido',
        error: 'Bad Request',
        timestamp: expect.any(String) as string,
        path: '/api/v1/auth/login',
      }),
    );
    expect(captured.body).not.toHaveProperty('code');
  });

  it('mapea P2002 a 409 sin exponer detalles del motor ni agregar code', () => {
    const captured: CapturedResponse = {};
    const exception = new Prisma.PrismaClientKnownRequestError(
      'duplicate key',
      {
        code: 'P2002',
        clientVersion: '6.19.3',
      },
    );

    filter.catch(exception, createHost(captured));

    expect(captured.statusCode).toBe(409);
    expect(captured.body).not.toHaveProperty('code');
    expect(JSON.stringify(captured.body)).not.toContain('duplicate key');
  });

  it('mapea P2025 a 404', () => {
    const captured: CapturedResponse = {};
    const exception = new Prisma.PrismaClientKnownRequestError('not found', {
      code: 'P2025',
      clientVersion: '6.19.3',
    });

    filter.catch(exception, createHost(captured));

    expect(captured.statusCode).toBe(404);
  });

  it('errores desconocidos responden 500 sin filtrar detalles internos', () => {
    const captured: CapturedResponse = {};
    const exception = new Error('detalle interno sensible');

    filter.catch(exception, createHost(captured));

    expect(captured.statusCode).toBe(500);
    expect(JSON.stringify(captured.body)).not.toContain(
      'detalle interno sensible',
    );
    expect(captured.body).not.toHaveProperty('code');
  });
});

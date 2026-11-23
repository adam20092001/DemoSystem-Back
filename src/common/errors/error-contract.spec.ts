import {
  ArgumentMetadata,
  BadRequestException,
  ConflictException,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import { createValidationPipe } from '../pipes/validation.pipe';
import {
  BusinessConflictException,
  FieldBadRequestException,
} from './error-contract';

class LineDto {
  @IsString()
  @IsNotEmpty()
  quantity!: string;

  @Matches(/^\d+$/)
  code!: string;
}

class DocDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineDto)
  lines!: LineDto[];
}

const metadata: ArgumentMetadata = { type: 'body', metatype: DocDto };

interface Captured {
  status?: number;
  body?: Record<string, unknown>;
}

function run(exception: unknown): Captured {
  const captured: Captured = {};
  const response = {
    status: (s: number) => {
      captured.status = s;
      return response;
    },
    json: (b: Record<string, unknown>) => {
      captured.body = b;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'POST', url: '/api/v1/x' }),
      getResponse: () => response,
    }),
  };
  new AllExceptionsFilter().catch(exception, host as never);
  return captured;
}

async function validationError(payload: unknown): Promise<Captured> {
  try {
    await createValidationPipe().transform(payload, metadata);
  } catch (e) {
    return run(e);
  }
  throw new Error('se esperaba un error de validación');
}

describe('Contrato común de errores (R4)', () => {
  it('campo obligatorio faltante: REQUIRED, kind FORM, 400 y message sigue siendo arreglo', async () => {
    const res = await validationError({ lines: [] });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body?.message)).toBe(true);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      kind: 'FORM',
      statusCode: 400,
      error: 'Bad Request',
    });
    expect(res.body?.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'name',
          code: 'REQUIRED',
          type: 'REQUIRED',
        }),
      ]),
    );
  });

  it('formato inválido en un campo anidado de un arreglo: ruta lines[1].code', async () => {
    const res = await validationError({
      name: 'x',
      lines: [
        { quantity: '1', code: '1' },
        { quantity: '2', code: 'abc' },
      ],
    });
    expect(res.body?.errors).toEqual([
      expect.objectContaining({
        field: 'lines[1].code',
        code: 'INVALID_FORMAT',
        type: 'FORMAT',
      }),
    ]);
  });

  it('varios errores simultáneos: uno por campo afectado, con índice de línea', async () => {
    const res = await validationError({
      lines: [{ code: 'z' }, { quantity: '1', code: '9' }],
    });
    const fields = (res.body?.errors as { field: string }[]).map(
      (e) => e.field,
    );
    expect(fields).toEqual(
      expect.arrayContaining(['name', 'lines[0].quantity', 'lines[0].code']),
    );
    expect(fields.some((f) => f.startsWith('lines[1]'))).toBe(false);
  });

  it('propiedad no declarada: UNKNOWN_FIELD (FORMAT)', async () => {
    const res = await validationError({ name: 'x', lines: [], extra: 1 });
    expect(res.body?.errors).toEqual([
      expect.objectContaining({
        field: 'extra',
        code: 'UNKNOWN_FIELD',
        type: 'FORMAT',
      }),
    ]);
  });

  it('regla de negocio atribuida a un campo: 400 con type BUSINESS y kind FORM', () => {
    const res = run(
      new FieldBadRequestException({
        message: 'La tasa de cambio es obligatoria',
        code: 'EXCHANGE_RATE_REQUIRED',
        field: 'exchangeRate',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      kind: 'FORM',
      code: 'EXCHANGE_RATE_REQUIRED',
      message: 'La tasa de cambio es obligatoria',
      errors: [
        {
          field: 'exchangeRate',
          code: 'EXCHANGE_RATE_REQUIRED',
          type: 'BUSINESS',
        },
      ],
    });
  });

  it('conflicto general sin campo: 409, kind GENERAL y sin errors', () => {
    const res = run(
      new BusinessConflictException({
        message: 'El periodo contable está cerrado',
        code: 'PERIOD_CLOSED',
      }),
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ kind: 'GENERAL', code: 'PERIOD_CLOSED' });
    expect(res.body).not.toHaveProperty('errors');
  });

  it('conflicto de negocio atribuido a un campo conserva 409', () => {
    const res = run(
      new BusinessConflictException({
        message: 'La factura no está confirmada',
        code: 'INVOICE_NOT_CONFIRMED',
        field: 'purchaseInvoiceId',
      }),
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      kind: 'FORM',
      errors: [{ field: 'purchaseInvoiceId', type: 'BUSINESS' }],
    });
  });

  it('excepciones existentes sin estructura siguen igual (message string, kind GENERAL, sin code)', () => {
    const res = run(new ConflictException('El periodo está cerrado'));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      message: 'El periodo está cerrado',
      error: 'Conflict',
      kind: 'GENERAL',
    });
    expect(res.body).not.toHaveProperty('code');
    expect(res.body).not.toHaveProperty('errors');
  });

  it('5xx no expone detalles internos ni errores por campo', () => {
    const res = run(new InternalServerErrorException('SELECT * FROM secret'));
    expect(res.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(res.body?.message).toBe('Error interno del servidor');
    expect(JSON.stringify(res.body)).not.toContain('SELECT');
    expect(res.body).not.toHaveProperty('errors');
  });

  it('el pipe sigue produciendo BadRequestException (400)', async () => {
    await expect(
      createValidationPipe().transform({}, metadata),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import {
  CustomerDocumentType,
  CustomerStage,
  CustomerStatus,
  CustomerType,
} from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createValidationPipe } from '../../common/pipes/validation.pipe';
import { CreateCustomerDto } from './create-customer.dto';
import { ListCustomersQueryDto } from './list-customers-query.dto';
import { UpdateCustomerDto } from './update-customer.dto';

async function expectRejectedProperty(
  Dto: new () => object,
  payload: Record<string, unknown>,
  offendingProperty: string,
): Promise<void> {
  const pipe = createValidationPipe();
  expect.assertions(2);
  try {
    await pipe.transform(payload, { type: 'body', metatype: Dto });
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as {
      message: string[];
    };
    expect(body.message.join(' ')).toMatch(new RegExp(offendingProperty));
  }
}

describe('CreateCustomerDto', () => {
  const basePerson = {
    customerType: CustomerType.PERSON,
    customerStage: CustomerStage.PROSPECT,
    name: 'Cliente Uno',
  };

  it('PERSON válido no reporta errores', async () => {
    const instance = plainToInstance(CreateCustomerDto, basePerson);
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('COMPANY válido no reporta errores', async () => {
    const instance = plainToInstance(CreateCustomerDto, {
      ...basePerson,
      customerType: CustomerType.COMPANY,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('customerStage PROSPECT válido no reporta errores', async () => {
    const instance = plainToInstance(CreateCustomerDto, {
      ...basePerson,
      customerStage: CustomerStage.PROSPECT,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('customerStage CUSTOMER válido no reporta errores', async () => {
    const instance = plainToInstance(CreateCustomerDto, {
      ...basePerson,
      customerStage: CustomerStage.CUSTOMER,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('cliente sin documento (ambos ausentes) es válido', async () => {
    const instance = plainToInstance(CreateCustomerDto, basePerson);
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('cliente con par de documento completo es válido', async () => {
    const instance = plainToInstance(CreateCustomerDto, {
      ...basePerson,
      documentType: CustomerDocumentType.DNI,
      documentNumber: '12345678',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('customerType inválido → error', async () => {
    const instance = plainToInstance(CreateCustomerDto, {
      ...basePerson,
      customerType: 'NOT_A_TYPE',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'customerType')).toBe(
      true,
    );
  });

  it('customerStage inválido → error', async () => {
    const instance = plainToInstance(CreateCustomerDto, {
      ...basePerson,
      customerStage: 'NOT_A_STAGE',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'customerStage')).toBe(
      true,
    );
  });

  it('documentType inválido → error', async () => {
    const instance = plainToInstance(CreateCustomerDto, {
      ...basePerson,
      documentType: 'NOT_A_DOC_TYPE',
      documentNumber: '12345678',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'documentType')).toBe(
      true,
    );
  });

  it('email inválido → error', async () => {
    const instance = plainToInstance(CreateCustomerDto, {
      ...basePerson,
      email: 'no-es-un-email',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'email')).toBe(true);
  });

  it.each([
    ['name', 151],
    ['tradeName', 151],
    ['contactName', 121],
    ['email', 151],
    ['phone', 31],
    ['address', 301],
    ['internalNotes', 1001],
    ['documentNumber', 33],
  ])('%s mayor al máximo permitido → error', async (field, length) => {
    const instance = plainToInstance(CreateCustomerDto, {
      ...basePerson,
      [field]:
        field === 'email'
          ? `${'a'.repeat(length - 10)}@x.com`
          : 'a'.repeat(length),
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === field)).toBe(true);
  });

  it('name ausente → error (requerido)', async () => {
    const instance = plainToInstance(CreateCustomerDto, {
      customerType: CustomerType.PERSON,
      customerStage: CustomerStage.PROSPECT,
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'name')).toBe(true);
  });

  it('name vacío → error (requerido)', async () => {
    const instance = plainToInstance(CreateCustomerDto, {
      ...basePerson,
      name: '',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'name')).toBe(true);
  });

  it('propiedad desconocida es rechazada por la configuración global (whitelist + forbidNonWhitelisted)', async () => {
    await expectRejectedProperty(
      CreateCustomerDto,
      { ...basePerson, unexpectedField: 'algo' },
      'unexpectedField',
    );
  });

  it.each(['code', 'isGeneric', 'status'])(
    'CREATE: intento de enviar "%s" es rechazado por el ValidationPipe global',
    async (field) => {
      await expectRejectedProperty(
        CreateCustomerDto,
        { ...basePerson, [field]: 'valor-arbitrario' },
        field,
      );
    },
  );
});

describe('UpdateCustomerDto', () => {
  it('todos los campos mutables aprobados son aceptados', async () => {
    const instance = plainToInstance(UpdateCustomerDto, {
      name: 'Nuevo Nombre',
      tradeName: 'Nombre Comercial',
      contactName: 'Contacto',
      email: 'nuevo@example.com',
      phone: '999999999',
      address: 'Dirección',
      internalNotes: 'Notas internas',
      documentType: CustomerDocumentType.RUC,
      documentNumber: '20123456789',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('documentType/documentNumber admiten null explícito (limpiar el par)', async () => {
    const instance = plainToInstance(UpdateCustomerDto, {
      documentType: null,
      documentNumber: null,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
    expect(instance.documentType).toBeNull();
    expect(instance.documentNumber).toBeNull();
  });

  it('payload vacío es válido a nivel de DTO (CustomersService rechaza con 400)', async () => {
    const instance = plainToInstance(UpdateCustomerDto, {});
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('email inválido → error', async () => {
    const instance = plainToInstance(UpdateCustomerDto, {
      email: 'no-es-un-email',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'email')).toBe(true);
  });

  it.each([
    ['name', 151],
    ['tradeName', 151],
    ['contactName', 121],
    ['phone', 31],
    ['address', 301],
    ['internalNotes', 1001],
    ['documentNumber', 33],
  ])('%s mayor al máximo permitido → error', async (field, length) => {
    const instance = plainToInstance(UpdateCustomerDto, {
      [field]: 'a'.repeat(length),
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === field)).toBe(true);
  });

  it.each([
    'code',
    'customerType',
    'customerStage',
    'status',
    'isGeneric',
    'id',
    'createdAt',
    'updatedAt',
  ])(
    'UPDATE: intento de enviar "%s" es rechazado por el ValidationPipe global (whitelist)',
    async (field) => {
      await expectRejectedProperty(
        UpdateCustomerDto,
        { name: 'Nombre válido', [field]: 'valor-arbitrario' },
        field,
      );
    },
  );
});

describe('ListCustomersQueryDto', () => {
  it('page/limit se transforman a enteros', async () => {
    const instance = plainToInstance(ListCustomersQueryDto, {
      page: '2',
      limit: '50',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
    expect(instance.page).toBe(2);
    expect(instance.limit).toBe(50);
  });

  it('page < 1 → error', async () => {
    const instance = plainToInstance(ListCustomersQueryDto, { page: '0' });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'page')).toBe(true);
  });

  it('limit < 1 → error', async () => {
    const instance = plainToInstance(ListCustomersQueryDto, { limit: '0' });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });

  it('limit > 100 → error', async () => {
    const instance = plainToInstance(ListCustomersQueryDto, { limit: '500' });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });

  it('status inválido → error @IsEnum', async () => {
    const instance = plainToInstance(ListCustomersQueryDto, {
      status: 'NOT_A_STATUS',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'status')).toBe(true);
  });

  it('status válido no reporta errores', async () => {
    const instance = plainToInstance(ListCustomersQueryDto, {
      status: CustomerStatus.BLOCKED,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('customerType inválido → error @IsEnum', async () => {
    const instance = plainToInstance(ListCustomersQueryDto, {
      customerType: 'NOT_A_TYPE',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'customerType')).toBe(
      true,
    );
  });

  it('customerStage inválido → error @IsEnum', async () => {
    const instance = plainToInstance(ListCustomersQueryDto, {
      customerStage: 'NOT_A_STAGE',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'customerStage')).toBe(
      true,
    );
  });

  it('documentType inválido → error @IsEnum', async () => {
    const instance = plainToInstance(ListCustomersQueryDto, {
      documentType: 'NOT_A_DOC_TYPE',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'documentType')).toBe(
      true,
    );
  });

  it('"true"/"false" (string) se transforman correctamente en isGeneric', async () => {
    const trueInstance = plainToInstance(ListCustomersQueryDto, {
      isGeneric: 'true',
    });
    const falseInstance = plainToInstance(ListCustomersQueryDto, {
      isGeneric: 'false',
    });
    expect((await validate(trueInstance)).length).toBe(0);
    expect((await validate(falseInstance)).length).toBe(0);
    expect(trueInstance.isGeneric).toBe(true);
    expect(falseInstance.isGeneric).toBe(false);
  });

  it('isGeneric boolean literal es válido', async () => {
    const instance = plainToInstance(ListCustomersQueryDto, {
      isGeneric: true,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it.each(['0', '1', 'yes', 'abc', ''])(
    'isGeneric con valor inválido %j no pasa la validación @IsBoolean',
    async (value) => {
      const instance = plainToInstance(ListCustomersQueryDto, {
        isGeneric: value,
      });
      const errors = await validate(instance);
      expect(errors.some((error) => error.property === 'isGeneric')).toBe(true);
    },
  );

  it('search se acepta como string', async () => {
    const instance = plainToInstance(ListCustomersQueryDto, {
      search: 'juan',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
    expect(instance.search).toBe('juan');
  });

  it('payload vacío es válido: todos los filtros son opcionales', async () => {
    const instance = plainToInstance(ListCustomersQueryDto, {});
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it.each(['orderBy', 'sort', 'direction'])(
    '%s es rechazado por el ValidationPipe global (whitelist)',
    async (field) => {
      await expectRejectedProperty(
        ListCustomersQueryDto,
        { [field]: 'name' },
        field,
      );
    },
  );

  it('propiedad desconocida es rechazada por el ValidationPipe global (whitelist)', async () => {
    await expectRejectedProperty(
      ListCustomersQueryDto,
      { unexpectedField: 'algo' },
      'unexpectedField',
    );
  });
});

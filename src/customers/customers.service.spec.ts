import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomerDocumentType,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  RoleName,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { CustomersService } from './customers.service';

const ACTOR_ID = 'actor-id';
const NOW = new Date('2026-01-01T00:00:00.000Z');

interface CustomerCreateArgs {
  data: Record<string, unknown>;
}
interface CustomerUpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}
interface CustomerFindUniqueArgs {
  where: { id: string };
  select?: Record<string, unknown>;
}
interface CustomerFindManyArgs {
  where?: Record<string, unknown>;
  select?: Record<string, unknown>;
  orderBy?: unknown;
  skip?: number;
  take?: number;
}
interface CustomerCountArgs {
  where?: Record<string, unknown>;
}

function makeCustomerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'customer-1',
    code: null,
    customerType: CustomerType.PERSON,
    customerStage: CustomerStage.PROSPECT,
    documentType: null,
    documentNumber: null,
    name: 'Cliente Uno',
    tradeName: null,
    contactName: null,
    email: null,
    phone: null,
    address: null,
    internalNotes: null,
    isGeneric: false,
    status: CustomerStatus.ACTIVE,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    customer: {
      create: jest.fn<Promise<unknown>, [CustomerCreateArgs]>(),
      findUnique: jest.fn<Promise<unknown>, [CustomerFindUniqueArgs]>(),
      update: jest.fn<Promise<unknown>, [CustomerUpdateArgs]>(),
    },
  };

  return {
    tx,
    customer: {
      findUnique: jest.fn<Promise<unknown>, [CustomerFindUniqueArgs]>(),
      findMany: jest.fn<Promise<unknown[]>, [CustomerFindManyArgs]>(),
      count: jest.fn<Promise<number>, [CustomerCountArgs?]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createAuditServiceMock() {
  return {
    record: jest.fn<Promise<void>, [Record<string, unknown>]>(),
  };
}

describe('CustomersService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: CustomersService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);

    service = new CustomersService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
  });

  describe('create', () => {
    const validInput = {
      customerType: CustomerType.PERSON,
      customerStage: CustomerStage.PROSPECT,
      name: '  Cliente Uno  ',
      actorUserId: ACTOR_ID,
      ipAddress: '10.0.0.1',
    };

    beforeEach(() => {
      prisma.tx.customer.create.mockResolvedValue(makeCustomerRow());
    });

    it('crea un cliente PERSON', async () => {
      await service.create({
        ...validInput,
        customerType: CustomerType.PERSON,
      });
      const createArgs = prisma.tx.customer.create.mock.calls[0][0];
      expect(createArgs.data.customerType).toBe(CustomerType.PERSON);
    });

    it('crea un cliente COMPANY', async () => {
      await service.create({
        ...validInput,
        customerType: CustomerType.COMPANY,
      });
      const createArgs = prisma.tx.customer.create.mock.calls[0][0];
      expect(createArgs.data.customerType).toBe(CustomerType.COMPANY);
    });

    it('crea con customerStage PROSPECT', async () => {
      await service.create({
        ...validInput,
        customerStage: CustomerStage.PROSPECT,
      });
      const createArgs = prisma.tx.customer.create.mock.calls[0][0];
      expect(createArgs.data.customerStage).toBe(CustomerStage.PROSPECT);
    });

    it('crea con customerStage CUSTOMER', async () => {
      await service.create({
        ...validInput,
        customerStage: CustomerStage.CUSTOMER,
      });
      const createArgs = prisma.tx.customer.create.mock.calls[0][0];
      expect(createArgs.data.customerStage).toBe(CustomerStage.CUSTOMER);
    });

    it('crea un cliente sin documento (ambos undefined)', async () => {
      await service.create(validInput);
      const createArgs = prisma.tx.customer.create.mock.calls[0][0];
      expect(createArgs.data.documentType).toBeNull();
      expect(createArgs.data.documentNumber).toBeNull();
    });

    it('crea un cliente con par de documento completo, normalizado (trim+upper)', async () => {
      await service.create({
        ...validInput,
        documentType: CustomerDocumentType.DNI,
        documentNumber: '  12345678  ',
      });
      const createArgs = prisma.tx.customer.create.mock.calls[0][0];
      expect(createArgs.data.documentType).toBe(CustomerDocumentType.DNI);
      expect(createArgs.data.documentNumber).toBe('12345678');
    });

    it('rechaza un par de documento incompleto (solo documentType)', async () => {
      await expect(
        service.create({
          ...validInput,
          documentType: CustomerDocumentType.DNI,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rechaza un par de documento incompleto (solo documentNumber)', async () => {
      await expect(
        service.create({ ...validInput, documentNumber: '12345678' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('recorta (trim) el nombre sin cambiar mayúsculas', async () => {
      await service.create(validInput);
      const createArgs = prisma.tx.customer.create.mock.calls[0][0];
      expect(createArgs.data.name).toBe('Cliente Uno');
    });

    it('rechaza nombre vacío tras trim', async () => {
      await expect(
        service.create({ ...validInput, name: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('normaliza documentNumber con trim + mayúsculas', async () => {
      await service.create({
        ...validInput,
        documentType: CustomerDocumentType.CE,
        documentNumber: '  ce-abc123  ',
      });
      const createArgs = prisma.tx.customer.create.mock.calls[0][0];
      expect(createArgs.data.documentNumber).toBe('CE-ABC123');
    });

    it('normaliza email a minúsculas', async () => {
      await service.create({ ...validInput, email: '  Juan@Example.COM  ' });
      const createArgs = prisma.tx.customer.create.mock.calls[0][0];
      expect(createArgs.data.email).toBe('juan@example.com');
    });

    it('campos opcionales vacíos o ausentes se guardan como null', async () => {
      await service.create({
        ...validInput,
        tradeName: '   ',
        contactName: undefined,
        email: '',
        phone: '   ',
        address: undefined,
        internalNotes: '',
      });
      const createArgs = prisma.tx.customer.create.mock.calls[0][0];
      expect(createArgs.data.tradeName).toBeNull();
      expect(createArgs.data.contactName).toBeNull();
      expect(createArgs.data.email).toBeNull();
      expect(createArgs.data.phone).toBeNull();
      expect(createArgs.data.address).toBeNull();
      expect(createArgs.data.internalNotes).toBeNull();
    });

    it('registra auditoría CUSTOMER_CREATED con la whitelist esperada', async () => {
      await service.create({
        ...validInput,
        documentType: CustomerDocumentType.DNI,
        documentNumber: '12345678',
      });

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CUSTOMER_CREATED,
          entityType: 'Customer',
          module: 'CUSTOMERS',
          metadata: {
            customerType: CustomerType.PERSON,
            customerStage: CustomerStage.PROSPECT,
            documentType: CustomerDocumentType.DNI,
          },
        }),
      );
    });

    it('la auditoría usa el cliente de la transacción', async () => {
      await service.create(validInput);
      const call = auditService.record.mock.calls[0][0] as { client: unknown };
      expect(call.client).toBe(prisma.tx);
    });

    it('usa el select seguro y el mapper (respuesta sin campos internos inesperados)', async () => {
      const result = await service.create(validInput);
      expect(result).toEqual({
        id: 'customer-1',
        code: null,
        customerType: CustomerType.PERSON,
        customerStage: CustomerStage.PROSPECT,
        documentType: null,
        documentNumber: null,
        name: 'Cliente Uno',
        tradeName: null,
        contactName: null,
        email: null,
        phone: null,
        address: null,
        internalNotes: null,
        isGeneric: false,
        status: CustomerStatus.ACTIVE,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });

    it('nunca es posible crear el cliente genérico: isGeneric siempre false y code nunca se envía', async () => {
      await service.create(validInput);
      const createArgs = prisma.tx.customer.create.mock.calls[0][0];
      expect(createArgs.data.isGeneric).toBe(false);
      expect('code' in createArgs.data).toBe(false);
      expect(createArgs.data.status).toBe(CustomerStatus.ACTIVE);
    });
  });

  describe('list', () => {
    beforeEach(() => {
      prisma.customer.findMany.mockResolvedValue([]);
      prisma.customer.count.mockResolvedValue(0);
    });

    it('usa paginación por defecto (page=1, limit=20)', async () => {
      await service.list({}, RoleName.ADMIN);
      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args?.skip).toBe(0);
      expect(args?.take).toBe(20);
    });

    it('limita el límite máximo a 100', async () => {
      await service.list({ limit: 500 }, RoleName.ADMIN);
      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args?.take).toBe(100);
    });

    it('filtra por customerType', async () => {
      await service.list(
        { customerType: CustomerType.COMPANY },
        RoleName.ADMIN,
      );
      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args?.where?.customerType).toBe(CustomerType.COMPANY);
    });

    it('filtra por customerStage', async () => {
      await service.list(
        { customerStage: CustomerStage.CUSTOMER },
        RoleName.ADMIN,
      );
      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args?.where?.customerStage).toBe(CustomerStage.CUSTOMER);
    });

    it('filtra por documentType', async () => {
      await service.list(
        { documentType: CustomerDocumentType.RUC },
        RoleName.ADMIN,
      );
      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args?.where?.documentType).toBe(CustomerDocumentType.RUC);
    });

    it('filtra por isGeneric', async () => {
      await service.list({ isGeneric: true }, RoleName.ADMIN);
      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args?.where?.isGeneric).toBe(true);
    });

    it('búsqueda genera OR sobre documentNumber/name/phone/tradeName/contactName/email en modo insensible', async () => {
      await service.list({ search: 'juan' }, RoleName.ADMIN);
      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args?.where?.OR).toEqual([
        { documentNumber: { contains: 'juan', mode: 'insensitive' } },
        { name: { contains: 'juan', mode: 'insensitive' } },
        { phone: { contains: 'juan', mode: 'insensitive' } },
        { tradeName: { contains: 'juan', mode: 'insensitive' } },
        { contactName: { contains: 'juan', mode: 'insensitive' } },
        { email: { contains: 'juan', mode: 'insensitive' } },
      ]);
    });

    it('búsqueda de solo espacios se omite por completo', async () => {
      await service.list({ search: '   ' }, RoleName.ADMIN);
      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args?.where?.OR).toBeUndefined();
    });

    it('ADMIN sin filtro de status ve ACTIVE/INACTIVE/BLOCKED', async () => {
      await service.list({}, RoleName.ADMIN);
      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args?.where?.status).toEqual({
        in: [
          CustomerStatus.ACTIVE,
          CustomerStatus.INACTIVE,
          CustomerStatus.BLOCKED,
        ],
      });
    });

    it('MANAGEMENT sin filtro de status ve ACTIVE/INACTIVE/BLOCKED', async () => {
      await service.list({}, RoleName.MANAGEMENT);
      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args?.where?.status).toEqual({
        in: [
          CustomerStatus.ACTIVE,
          CustomerStatus.INACTIVE,
          CustomerStatus.BLOCKED,
        ],
      });
    });

    it('SELLER puede filtrar status=ACTIVE', async () => {
      await service.list({ status: CustomerStatus.ACTIVE }, RoleName.SELLER);
      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args?.where?.status).toBe(CustomerStatus.ACTIVE);
    });

    it('SELLER puede filtrar status=BLOCKED', async () => {
      await service.list({ status: CustomerStatus.BLOCKED }, RoleName.SELLER);
      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args?.where?.status).toBe(CustomerStatus.BLOCKED);
    });

    it('SELLER sin filtro de status nunca ve INACTIVE (solo ACTIVE/BLOCKED)', async () => {
      await service.list({}, RoleName.SELLER);
      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args?.where?.status).toEqual({
        in: [CustomerStatus.ACTIVE, CustomerStatus.BLOCKED],
      });
    });

    it('SELLER filtrando explícitamente status=INACTIVE recibe página vacía sin consultar la base', async () => {
      const result = await service.list(
        { status: CustomerStatus.INACTIVE },
        RoleName.SELLER,
      );
      expect(result).toEqual({
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
      expect(prisma.customer.findMany).not.toHaveBeenCalled();
      expect(prisma.customer.count).not.toHaveBeenCalled();
    });

    it('WAREHOUSE recibe una página vacía sin consultar la base, sin filtro de status', async () => {
      const result = await service.list({}, RoleName.WAREHOUSE);
      expect(result).toEqual({
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
      expect(prisma.customer.findMany).not.toHaveBeenCalled();
      expect(prisma.customer.count).not.toHaveBeenCalled();
    });

    it('WAREHOUSE recibe una página vacía sin consultar la base, incluso filtrando status=ACTIVE', async () => {
      const result = await service.list(
        { status: CustomerStatus.ACTIVE },
        RoleName.WAREHOUSE,
      );
      expect(result).toEqual({
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
      expect(prisma.customer.findMany).not.toHaveBeenCalled();
      expect(prisma.customer.count).not.toHaveBeenCalled();
    });

    it('orden determinista fijo: createdAt desc, id desc', async () => {
      await service.list({}, RoleName.ADMIN);
      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args?.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('findMany y count usan el mismo where', async () => {
      await service.list(
        { customerType: CustomerType.PERSON, search: 'ana' },
        RoleName.ADMIN,
      );
      const findManyWhere = prisma.customer.findMany.mock.calls[0][0]?.where;
      const countWhere = prisma.customer.count.mock.calls[0][0]?.where;
      expect(findManyWhere).toEqual(countWhere);
    });

    it('página vacía es válida (total=0 => totalPages=0)', async () => {
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });
  });

  describe('findOne', () => {
    it('devuelve el cliente cuando existe y es visible', async () => {
      prisma.customer.findUnique.mockResolvedValue(makeCustomerRow());
      const result = await service.findOne('customer-1', RoleName.ADMIN);
      expect(result.id).toBe('customer-1');
    });

    it('lanza NotFoundException si no existe', async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await expect(
        service.findOne('missing', RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ADMIN puede ver un cliente INACTIVE', async () => {
      prisma.customer.findUnique.mockResolvedValue(
        makeCustomerRow({ status: CustomerStatus.INACTIVE }),
      );
      const result = await service.findOne('customer-1', RoleName.ADMIN);
      expect(result.status).toBe(CustomerStatus.INACTIVE);
    });

    it('MANAGEMENT puede ver un cliente INACTIVE', async () => {
      prisma.customer.findUnique.mockResolvedValue(
        makeCustomerRow({ status: CustomerStatus.INACTIVE }),
      );
      const result = await service.findOne('customer-1', RoleName.MANAGEMENT);
      expect(result.status).toBe(CustomerStatus.INACTIVE);
    });

    it('SELLER puede ver un cliente ACTIVE', async () => {
      prisma.customer.findUnique.mockResolvedValue(
        makeCustomerRow({ status: CustomerStatus.ACTIVE }),
      );
      const result = await service.findOne('customer-1', RoleName.SELLER);
      expect(result.status).toBe(CustomerStatus.ACTIVE);
    });

    it('SELLER puede ver un cliente BLOCKED', async () => {
      prisma.customer.findUnique.mockResolvedValue(
        makeCustomerRow({ status: CustomerStatus.BLOCKED }),
      );
      const result = await service.findOne('customer-1', RoleName.SELLER);
      expect(result.status).toBe(CustomerStatus.BLOCKED);
    });

    it('SELLER recibe 404 (no revelador) para un cliente INACTIVE', async () => {
      prisma.customer.findUnique.mockResolvedValue(
        makeCustomerRow({ status: CustomerStatus.INACTIVE }),
      );
      await expect(
        service.findOne('customer-1', RoleName.SELLER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      CustomerStatus.ACTIVE,
      CustomerStatus.INACTIVE,
      CustomerStatus.BLOCKED,
    ])(
      'WAREHOUSE nunca recibe datos del cliente (status=%s) -> NotFoundException, no 403',
      async (status) => {
        prisma.customer.findUnique.mockResolvedValue(
          makeCustomerRow({ status }),
        );
        await expect(
          service.findOne('customer-1', RoleName.WAREHOUSE),
        ).rejects.toBeInstanceOf(NotFoundException);
      },
    );
  });

  describe('update', () => {
    beforeEach(() => {
      prisma.tx.customer.findUnique.mockResolvedValue({
        id: 'customer-1',
        isGeneric: false,
      });
      prisma.tx.customer.update.mockResolvedValue(
        makeCustomerRow({ phone: '999999999' }),
      );
    });

    it('actualiza campos normales (p. ej. phone)', async () => {
      await service.update({
        customerId: 'customer-1',
        phone: '  999999999  ',
        actorUserId: ACTOR_ID,
      });
      const updateArgs = prisma.tx.customer.update.mock.calls[0][0];
      expect(updateArgs.data.phone).toBe('999999999');
    });

    it('sin campos -> BadRequestException, sin abrir transacción', async () => {
      await expect(
        service.update({ customerId: 'customer-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('normaliza campos (email a minúsculas, tradeName vacío a null)', async () => {
      await service.update({
        customerId: 'customer-1',
        email: '  Juan@Example.COM  ',
        tradeName: '   ',
        actorUserId: ACTOR_ID,
      });
      const updateArgs = prisma.tx.customer.update.mock.calls[0][0];
      expect(updateArgs.data.email).toBe('juan@example.com');
      expect(updateArgs.data.tradeName).toBeNull();
    });

    it('par de documento incompleto (solo documentType) -> 400', async () => {
      await expect(
        service.update({
          customerId: 'customer-1',
          documentType: CustomerDocumentType.DNI,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('par de documento incompleto (solo documentNumber) -> 400', async () => {
      await expect(
        service.update({
          customerId: 'customer-1',
          documentNumber: '12345678',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('limpia el par de documento cuando ambos llegan null', async () => {
      await service.update({
        customerId: 'customer-1',
        documentType: null,
        documentNumber: null,
        actorUserId: ACTOR_ID,
      });
      const updateArgs = prisma.tx.customer.update.mock.calls[0][0];
      expect(updateArgs.data.documentType).toBeNull();
      expect(updateArgs.data.documentNumber).toBeNull();
    });

    it('reemplaza el par de documento cuando ambos llegan con valor', async () => {
      await service.update({
        customerId: 'customer-1',
        documentType: CustomerDocumentType.RUC,
        documentNumber: '  20123456789  ',
        actorUserId: ACTOR_ID,
      });
      const updateArgs = prisma.tx.customer.update.mock.calls[0][0];
      expect(updateArgs.data.documentType).toBe(CustomerDocumentType.RUC);
      expect(updateArgs.data.documentNumber).toBe('20123456789');
    });

    it('updatedFields contiene solo nombres de campo, no valores', async () => {
      await service.update({
        customerId: 'customer-1',
        name: 'Nuevo Nombre',
        phone: '999999999',
        actorUserId: ACTOR_ID,
      });
      const call = auditService.record.mock.calls[0][0] as {
        metadata: { updatedFields: string[] };
      };
      expect(call.metadata.updatedFields).toEqual(['name', 'phone']);
    });

    it('registra auditoría CUSTOMER_UPDATED usando el cliente de la transacción', async () => {
      await service.update({
        customerId: 'customer-1',
        phone: '999999999',
        actorUserId: ACTOR_ID,
      });
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        client: unknown;
      };
      expect(call.action).toBe(AuditAction.CUSTOMER_UPDATED);
      expect(call.client).toBe(prisma.tx);
    });

    it('cliente genérico -> ConflictException', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue({
        id: 'customer-1',
        isGeneric: true,
      });
      await expect(
        service.update({
          customerId: 'customer-1',
          phone: '999999999',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.customer.update).not.toHaveBeenCalled();
    });

    it('cliente inexistente -> NotFoundException', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue(null);
      await expect(
        service.update({
          customerId: 'missing',
          phone: '999999999',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe.each([
    {
      method: 'activate' as const,
      from: CustomerStatus.INACTIVE,
      to: CustomerStatus.ACTIVE,
      action: AuditAction.CUSTOMER_ACTIVATED,
      invalidFrom: [CustomerStatus.ACTIVE, CustomerStatus.BLOCKED],
    },
    {
      method: 'deactivate' as const,
      from: CustomerStatus.ACTIVE,
      to: CustomerStatus.INACTIVE,
      action: AuditAction.CUSTOMER_DEACTIVATED,
      invalidFrom: [CustomerStatus.INACTIVE, CustomerStatus.BLOCKED],
    },
    {
      method: 'block' as const,
      from: CustomerStatus.ACTIVE,
      to: CustomerStatus.BLOCKED,
      action: AuditAction.CUSTOMER_BLOCKED,
      invalidFrom: [CustomerStatus.BLOCKED, CustomerStatus.INACTIVE],
    },
    {
      method: 'unblock' as const,
      from: CustomerStatus.BLOCKED,
      to: CustomerStatus.ACTIVE,
      action: AuditAction.CUSTOMER_UNBLOCKED,
      invalidFrom: [CustomerStatus.ACTIVE, CustomerStatus.INACTIVE],
    },
  ])('$method', ({ method, from, to, action, invalidFrom }) => {
    it(`${from} -> ${to} tiene éxito`, async () => {
      prisma.tx.customer.findUnique.mockResolvedValue({
        id: 'customer-1',
        status: from,
        isGeneric: false,
      });
      prisma.tx.customer.update.mockResolvedValue(
        makeCustomerRow({ status: to }),
      );

      const result = await service[method]({
        customerId: 'customer-1',
        actorUserId: ACTOR_ID,
      });

      expect(result.status).toBe(to);
      const updateArgs = prisma.tx.customer.update.mock.calls[0][0];
      expect(updateArgs.data.status).toBe(to);
    });

    it.each(invalidFrom)(
      'transición inválida desde %s -> ConflictException',
      async (invalidStatus) => {
        prisma.tx.customer.findUnique.mockResolvedValue({
          id: 'customer-1',
          status: invalidStatus,
          isGeneric: false,
        });

        await expect(
          service[method]({ customerId: 'customer-1', actorUserId: ACTOR_ID }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.tx.customer.update).not.toHaveBeenCalled();
      },
    );

    it('cliente genérico -> ConflictException', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue({
        id: 'customer-1',
        status: from,
        isGeneric: true,
      });

      await expect(
        service[method]({ customerId: 'customer-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.customer.update).not.toHaveBeenCalled();
    });

    it('cliente inexistente -> NotFoundException', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue(null);

      await expect(
        service[method]({ customerId: 'missing', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('registra auditoría con previousStatus', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue({
        id: 'customer-1',
        status: from,
        isGeneric: false,
      });
      prisma.tx.customer.update.mockResolvedValue(
        makeCustomerRow({ status: to }),
      );

      await service[method]({
        customerId: 'customer-1',
        actorUserId: ACTOR_ID,
      });

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action,
          metadata: { previousStatus: from },
          client: prisma.tx,
        }),
      );
    });
  });

  describe('convertToCustomer', () => {
    it('PROSPECT -> CUSTOMER tiene éxito', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue({
        id: 'customer-1',
        customerStage: CustomerStage.PROSPECT,
        isGeneric: false,
      });
      prisma.tx.customer.update.mockResolvedValue(
        makeCustomerRow({ customerStage: CustomerStage.CUSTOMER }),
      );

      const result = await service.convertToCustomer({
        customerId: 'customer-1',
        actorUserId: ACTOR_ID,
      });

      expect(result.customerStage).toBe(CustomerStage.CUSTOMER);
    });

    it('CUSTOMER -> CUSTOMER -> ConflictException', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue({
        id: 'customer-1',
        customerStage: CustomerStage.CUSTOMER,
        isGeneric: false,
      });

      await expect(
        service.convertToCustomer({
          customerId: 'customer-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.customer.update).not.toHaveBeenCalled();
    });

    it('cliente genérico -> ConflictException', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue({
        id: 'customer-1',
        customerStage: CustomerStage.PROSPECT,
        isGeneric: true,
      });

      await expect(
        service.convertToCustomer({
          customerId: 'customer-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.customer.update).not.toHaveBeenCalled();
    });

    it('cliente inexistente -> NotFoundException', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue(null);

      await expect(
        service.convertToCustomer({
          customerId: 'missing',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('registra auditoría CUSTOMER_STAGE_CHANGED con previousStage y customerStage', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue({
        id: 'customer-1',
        customerStage: CustomerStage.PROSPECT,
        isGeneric: false,
      });
      prisma.tx.customer.update.mockResolvedValue(
        makeCustomerRow({ customerStage: CustomerStage.CUSTOMER }),
      );

      await service.convertToCustomer({
        customerId: 'customer-1',
        actorUserId: ACTOR_ID,
      });

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CUSTOMER_STAGE_CHANGED,
          metadata: {
            previousStage: CustomerStage.PROSPECT,
            customerStage: CustomerStage.CUSTOMER,
          },
          client: prisma.tx,
        }),
      );
    });
  });
});

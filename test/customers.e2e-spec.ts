import { INestApplication } from '@nestjs/common';
import {
  CustomerDocumentType,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  PrismaClient,
  RoleName,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditAction } from '../src/audit/audit-action.enum';
import { assertAuditRowHasNoSecrets } from './helpers/audit-assertions';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

const SELLER_USERNAME = 'e2e_seller_customers';
const SELLER_PASSWORD = 'SellerCustomers123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_customers';
const WAREHOUSE_PASSWORD = 'WarehouseCustomers123';
const MANAGEMENT_USERNAME = 'e2e_management_customers';
const MANAGEMENT_PASSWORD = 'ManagementCustomers123';
const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';
const TEST_GENERIC_CODE = 'PUBLIC_GENERAL';

const SAFE_CUSTOMER_KEYS = [
  'id',
  'code',
  'customerType',
  'customerStage',
  'documentType',
  'documentNumber',
  'name',
  'tradeName',
  'contactName',
  'email',
  'phone',
  'address',
  'internalNotes',
  'isGeneric',
  'status',
  'createdAt',
  'updatedAt',
].sort();

interface SafeCustomerBody {
  id: string;
  code: string | null;
  customerType: CustomerType | null;
  customerStage: CustomerStage;
  documentType: CustomerDocumentType | null;
  documentNumber: string | null;
  name: string;
  tradeName: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  internalNotes: string | null;
  isGeneric: boolean;
  status: CustomerStatus;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedBody<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

describe('Customers (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;
  let managementCookie: string;
  let adminId: string;

  const createdCustomerIds: string[] = [];
  const directInsertIds: string[] = [];
  let genericCustomerId: string;

  const RUN_ID = Date.now();
  let counter = 0;
  function nextSuffix(): string {
    counter += 1;
    return `${RUN_ID}${counter}`;
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_customers@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_customers@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_customers@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });

    const adminLogin = await login(
      app.getHttpServer(),
      E2E_ADMIN_USERNAME,
      E2E_ADMIN_ACTIVE_PASSWORD,
    );
    if (adminLogin.status !== 200) {
      throw new Error(
        `No se pudo autenticar al admin de prueba: ${JSON.stringify(adminLogin.body)}`,
      );
    }
    adminCookie = adminLogin.cookie;
    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, SELLER_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, MANAGEMENT_PASSWORD)
    ).cookie;

    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { username: E2E_ADMIN_USERNAME },
    });
    adminId = adminUser.id;

    // Ficha propia del genérico de prueba (Bloque D, sección 6): NO se corre
    // el seed completo de desarrollo contra pos_db_test; se inserta/actualiza
    // directamente el único registro necesario, con los mismos invariantes
    // exactos que produce el seed real. Identidad exclusivamente por `code`.
    const generic = await prisma.customer.upsert({
      where: { code: TEST_GENERIC_CODE },
      update: {
        name: 'Público general',
        isGeneric: true,
        customerType: null,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        documentType: null,
        documentNumber: null,
      },
      create: {
        code: TEST_GENERIC_CODE,
        name: 'Público general',
        isGeneric: true,
        customerType: null,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        documentType: null,
        documentNumber: null,
      },
    });
    genericCustomerId = generic.id;
  });

  afterAll(async () => {
    try {
      const allOwnedIds = [...createdCustomerIds, genericCustomerId];

      // AuditLog no tiene FK hacia Customer (entityId es un string libre, por
      // diseño): se recolectan y eliminan explícitamente las auditorías que
      // pertenecen a los IDs de este spec, nunca con un deleteMany global de
      // AuditLog ni de Customer.
      if (allOwnedIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Customer', entityId: { in: allOwnedIds } },
        });
      }

      if (directInsertIds.length > 0) {
        const remainingDirect = await prisma.customer.findMany({
          where: { id: { in: directInsertIds } },
          select: { id: true },
        });
        if (remainingDirect.length > 0) {
          await prisma.customer.deleteMany({
            where: { id: { in: remainingDirect.map((row) => row.id) } },
          });
        }
      }

      if (createdCustomerIds.length > 0) {
        await prisma.customer.deleteMany({
          where: { id: { in: createdCustomerIds } },
        });
      }

      await prisma.customer.delete({ where: { id: genericCustomerId } });
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  function validCreateBody(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const suffix = nextSuffix();
    return {
      customerType: CustomerType.PERSON,
      customerStage: CustomerStage.PROSPECT,
      name: `Cliente E2E ${suffix}`,
      ...overrides,
    };
  }

  async function createCustomer(
    cookie: string,
    overrides: Record<string, unknown> = {},
  ): Promise<SafeCustomerBody> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('Cookie', cookie)
      .send(validCreateBody(overrides));
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear el cliente fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafeCustomerBody;
    createdCustomerIds.push(body.id);
    return body;
  }

  async function fetchAuditRows(
    action: AuditAction,
    entityId: string,
  ): Promise<
    {
      metadata: unknown;
      description: string;
      userId: string | null;
      module: string;
    }[]
  > {
    return prisma.auditLog.findMany({
      where: { action, entityType: 'Customer', entityId },
    });
  }

  /**
   * Inserta directamente en customers (bypass total del servicio) para
   * verificar que PostgreSQL rechaza la fila mediante el CHECK/índice
   * indicado. Solo se acopla al SQLSTATE (23514 = check_violation,
   * 23505 = unique_violation), nunca al texto completo del error, siguiendo
   * el mismo patrón que test/inventory.e2e-spec.ts.
   */
  async function expectPgRejection(
    insert: () => Promise<unknown>,
    sqlstate: '23514' | '23505',
  ): Promise<void> {
    let caught = false;
    try {
      await insert();
    } catch (error) {
      caught = true;
      const pgError = error as { code?: string; meta?: { code?: string } };
      expect(pgError.code).toBe('P2010');
      expect(pgError.meta?.code).toBe(sqlstate);
    }
    expect(caught).toBe(true);
  }

  function assertNoLeakage(response: { body: unknown }): void {
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/prisma/i);
    expect(serialized).not.toMatch(/P2002/);
    expect(serialized).not.toMatch(/P2010/);
    expect(serialized).not.toMatch(/23505/);
    expect(serialized).not.toMatch(/23514/);
    expect(serialized).not.toMatch(/constraint/i);
    expect(serialized).not.toMatch(/customers_/);
  }

  // ================================================================
  // 1. Autenticación (401 en los 9 endpoints)
  // ================================================================
  describe('autenticación', () => {
    it('sin cookie: los 9 endpoints responden 401', async () => {
      const server = app.getHttpServer();
      const id = NON_EXISTENT_UUID;

      const responses = await Promise.all([
        request(server).post('/api/v1/customers').send(validCreateBody()),
        request(server).get('/api/v1/customers'),
        request(server).get(`/api/v1/customers/${id}`),
        request(server).patch(`/api/v1/customers/${id}`).send({ name: 'x' }),
        request(server).post(`/api/v1/customers/${id}/activate`),
        request(server).post(`/api/v1/customers/${id}/deactivate`),
        request(server).post(`/api/v1/customers/${id}/block`),
        request(server).post(`/api/v1/customers/${id}/unblock`),
        request(server).post(`/api/v1/customers/${id}/convert-to-customer`),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(401);
      }
    });
  });

  // ================================================================
  // 2. Matriz de roles — cobertura HTTP completa
  // ================================================================
  describe('matriz de roles (HTTP real)', () => {
    let roleMatrixCustomerId: string;

    beforeAll(async () => {
      const created = await createCustomer(adminCookie, {
        customerStage: CustomerStage.PROSPECT,
      });
      roleMatrixCustomerId = created.id;
    });

    it('ADMIN: permitido en los 9 endpoints', async () => {
      const server = app.getHttpServer();

      const created = await request(server)
        .post('/api/v1/customers')
        .set('Cookie', adminCookie)
        .send(validCreateBody());
      expect(created.status).toBe(201);
      createdCustomerIds.push((created.body as SafeCustomerBody).id);
      const id = (created.body as SafeCustomerBody).id;

      expect(
        (
          await request(server)
            .get('/api/v1/customers')
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .get(`/api/v1/customers/${id}`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .patch(`/api/v1/customers/${id}`)
            .set('Cookie', adminCookie)
            .send({ phone: '999999999' })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .post(`/api/v1/customers/${id}/deactivate`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .post(`/api/v1/customers/${id}/activate`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .post(`/api/v1/customers/${id}/block`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .post(`/api/v1/customers/${id}/unblock`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .post(`/api/v1/customers/${id}/convert-to-customer`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
    });

    it('SELLER: permitido create/list/detail/update/convert; prohibido activate/deactivate/block/unblock', async () => {
      const server = app.getHttpServer();

      const created = await request(server)
        .post('/api/v1/customers')
        .set('Cookie', sellerCookie)
        .send(validCreateBody());
      expect(created.status).toBe(201);
      createdCustomerIds.push((created.body as SafeCustomerBody).id);
      const id = (created.body as SafeCustomerBody).id;

      expect(
        (
          await request(server)
            .get('/api/v1/customers')
            .set('Cookie', sellerCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .get(`/api/v1/customers/${id}`)
            .set('Cookie', sellerCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .patch(`/api/v1/customers/${id}`)
            .set('Cookie', sellerCookie)
            .send({ phone: '888888888' })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .post(`/api/v1/customers/${id}/convert-to-customer`)
            .set('Cookie', sellerCookie)
        ).status,
      ).toBe(200);

      expect(
        (
          await request(server)
            .post(`/api/v1/customers/${roleMatrixCustomerId}/activate`)
            .set('Cookie', sellerCookie)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(server)
            .post(`/api/v1/customers/${roleMatrixCustomerId}/deactivate`)
            .set('Cookie', sellerCookie)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(server)
            .post(`/api/v1/customers/${roleMatrixCustomerId}/block`)
            .set('Cookie', sellerCookie)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(server)
            .post(`/api/v1/customers/${roleMatrixCustomerId}/unblock`)
            .set('Cookie', sellerCookie)
        ).status,
      ).toBe(403);
    });

    it('MANAGEMENT: permitido solo list/detail; prohibido el resto', async () => {
      const server = app.getHttpServer();

      expect(
        (
          await request(server)
            .get('/api/v1/customers')
            .set('Cookie', managementCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .get(`/api/v1/customers/${roleMatrixCustomerId}`)
            .set('Cookie', managementCookie)
        ).status,
      ).toBe(200);

      expect(
        (
          await request(server)
            .post('/api/v1/customers')
            .set('Cookie', managementCookie)
            .send(validCreateBody())
        ).status,
      ).toBe(403);
      expect(
        (
          await request(server)
            .patch(`/api/v1/customers/${roleMatrixCustomerId}`)
            .set('Cookie', managementCookie)
            .send({ phone: '777777777' })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(server)
            .post(`/api/v1/customers/${roleMatrixCustomerId}/activate`)
            .set('Cookie', managementCookie)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(server)
            .post(`/api/v1/customers/${roleMatrixCustomerId}/deactivate`)
            .set('Cookie', managementCookie)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(server)
            .post(`/api/v1/customers/${roleMatrixCustomerId}/block`)
            .set('Cookie', managementCookie)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(server)
            .post(`/api/v1/customers/${roleMatrixCustomerId}/unblock`)
            .set('Cookie', managementCookie)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(server)
            .post(
              `/api/v1/customers/${roleMatrixCustomerId}/convert-to-customer`,
            )
            .set('Cookie', managementCookie)
        ).status,
      ).toBe(403);
    });

    it('WAREHOUSE: 403 en los 9 endpoints', async () => {
      const server = app.getHttpServer();
      const id = roleMatrixCustomerId;

      const responses = await Promise.all([
        request(server)
          .post('/api/v1/customers')
          .set('Cookie', warehouseCookie)
          .send(validCreateBody()),
        request(server).get('/api/v1/customers').set('Cookie', warehouseCookie),
        request(server)
          .get(`/api/v1/customers/${id}`)
          .set('Cookie', warehouseCookie),
        request(server)
          .patch(`/api/v1/customers/${id}`)
          .set('Cookie', warehouseCookie)
          .send({ phone: '1' }),
        request(server)
          .post(`/api/v1/customers/${id}/activate`)
          .set('Cookie', warehouseCookie),
        request(server)
          .post(`/api/v1/customers/${id}/deactivate`)
          .set('Cookie', warehouseCookie),
        request(server)
          .post(`/api/v1/customers/${id}/block`)
          .set('Cookie', warehouseCookie),
        request(server)
          .post(`/api/v1/customers/${id}/unblock`)
          .set('Cookie', warehouseCookie),
        request(server)
          .post(`/api/v1/customers/${id}/convert-to-customer`)
          .set('Cookie', warehouseCookie),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(403);
      }
    });
  });

  // ================================================================
  // 3. Creación
  // ================================================================
  describe('POST /customers — creación', () => {
    it('PERSON: 201, respuesta segura de 17 campos, valores de sistema correctos', async () => {
      const before = new Date();
      const response = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            customerType: CustomerType.PERSON,
            customerStage: CustomerStage.PROSPECT,
          }),
        );

      expect(response.status).toBe(201);
      const body = response.body as SafeCustomerBody;
      createdCustomerIds.push(body.id);

      expect(Object.keys(body).sort()).toEqual(SAFE_CUSTOMER_KEYS);
      expect(body.customerType).toBe(CustomerType.PERSON);
      expect(body.customerStage).toBe(CustomerStage.PROSPECT);
      expect(body.status).toBe(CustomerStatus.ACTIVE);
      expect(body.isGeneric).toBe(false);
      expect(body.code).toBeNull();
      expect(new Date(body.createdAt).getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1000,
      );
      expect(new Date(body.updatedAt).getTime()).toEqual(
        new Date(body.createdAt).getTime(),
      );
    });

    it('COMPANY: 201, name/tradeName/contactName persistidos', async () => {
      const suffix = nextSuffix();
      const response = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            customerType: CustomerType.COMPANY,
            name: `Empresa E2E ${suffix}`,
            tradeName: `Nombre Comercial ${suffix}`,
            contactName: `Contacto ${suffix}`,
          }),
        );

      expect(response.status).toBe(201);
      const body = response.body as SafeCustomerBody;
      createdCustomerIds.push(body.id);
      expect(body.customerType).toBe(CustomerType.COMPANY);
      expect(body.name).toBe(`Empresa E2E ${suffix}`);
      expect(body.tradeName).toBe(`Nombre Comercial ${suffix}`);
      expect(body.contactName).toBe(`Contacto ${suffix}`);
      expect(body.code).toBeNull();
      expect(body.isGeneric).toBe(false);
    });

    it('customerStage PROSPECT explícito se persiste', async () => {
      const body = await createCustomer(adminCookie, {
        customerStage: CustomerStage.PROSPECT,
      });
      expect(body.customerStage).toBe(CustomerStage.PROSPECT);
    });

    it('customerStage CUSTOMER explícito se persiste', async () => {
      const body = await createCustomer(adminCookie, {
        customerStage: CustomerStage.CUSTOMER,
      });
      expect(body.customerStage).toBe(CustomerStage.CUSTOMER);
    });

    it('cliente sin documento (omitido): documentType/documentNumber null en la fila', async () => {
      const body = await createCustomer(adminCookie);
      expect(body.documentType).toBeNull();
      expect(body.documentNumber).toBeNull();

      const row = await prisma.customer.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(row.documentType).toBeNull();
      expect(row.documentNumber).toBeNull();
    });

    it('par de documento: solo documentType -> 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ documentType: CustomerDocumentType.DNI }));
      expect(response.status).toBe(400);
    });

    it('par de documento: solo documentNumber -> 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ documentNumber: '12345678' }));
      expect(response.status).toBe(400);
    });

    it('par de documento completo -> 201', async () => {
      const suffix = nextSuffix();
      const body = await createCustomer(adminCookie, {
        documentType: CustomerDocumentType.DNI,
        documentNumber: `DOC${suffix}`,
      });
      expect(body.documentType).toBe(CustomerDocumentType.DNI);
      expect(body.documentNumber).toBe(`DOC${suffix}`);
    });
  });

  // ================================================================
  // 4. Normalización
  // ================================================================
  describe('normalización', () => {
    it('name: espacios al inicio/fin se recortan', async () => {
      const suffix = nextSuffix();
      const body = await createCustomer(adminCookie, {
        name: `   Nombre Con Espacios ${suffix}   `,
      });
      expect(body.name).toBe(`Nombre Con Espacios ${suffix}`);
    });

    it('documentNumber: trim + mayúsculas', async () => {
      const suffix = nextSuffix();
      const body = await createCustomer(adminCookie, {
        documentType: CustomerDocumentType.CE,
        documentNumber: `  ce-norm-${suffix}  `,
      });
      expect(body.documentNumber).toBe(`CE-NORM-${suffix}`.toUpperCase());
    });

    it('email: cadena completa HTTP -> DTO trim -> servicio lowercase -> persistido en PostgreSQL', async () => {
      const suffix = nextSuffix();
      const response = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            email: `  Customer.${suffix}@Example.COM  `,
          }),
        );

      expect(response.status).toBe(201);
      const body = response.body as SafeCustomerBody;
      createdCustomerIds.push(body.id);
      const expected = `customer.${suffix}@example.com`;
      expect(body.email).toBe(expected);

      const row = await prisma.customer.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(row.email).toBe(expected);
    });

    it('campos de texto opcionales en blanco se normalizan a null', async () => {
      const body = await createCustomer(adminCookie, {
        tradeName: '   ',
        contactName: '',
        phone: '   ',
        address: undefined,
        internalNotes: '',
      });
      expect(body.tradeName).toBeNull();
      expect(body.contactName).toBeNull();
      expect(body.phone).toBeNull();
      expect(body.address).toBeNull();
      expect(body.internalNotes).toBeNull();
    });
  });

  // ================================================================
  // 5. Documento duplicado (HTTP)
  // ================================================================
  describe('documento duplicado', () => {
    it('mismo documentType + documentNumber exacto -> 409', async () => {
      const suffix = nextSuffix();
      const documentNumber = `DUP${suffix}`;
      await createCustomer(adminCookie, {
        documentType: CustomerDocumentType.DNI,
        documentNumber,
      });

      const response = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            documentType: CustomerDocumentType.DNI,
            documentNumber,
          }),
        );
      expect(response.status).toBe(409);
      assertNoLeakage(response);
    });

    it('mismo documento con distinta capitalización (normalizada) -> 409', async () => {
      const suffix = nextSuffix();
      const documentNumber = `abc${suffix}`;
      await createCustomer(adminCookie, {
        documentType: CustomerDocumentType.OTHER,
        documentNumber,
      });

      const response = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            documentType: CustomerDocumentType.OTHER,
            documentNumber: documentNumber.toUpperCase(),
          }),
        );
      expect(response.status).toBe(409);
    });
  });

  // ================================================================
  // 6. Documento duplicado concurrente (HTTP real, Promise.all)
  // ================================================================
  describe('documento duplicado — concurrencia real', () => {
    it('dos POST concurrentes con el mismo par de documento: uno 201, uno 409, una sola fila', async () => {
      const suffix = nextSuffix();
      const documentNumber = `CONC${suffix}`;

      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/customers')
          .set('Cookie', adminCookie)
          .send(
            validCreateBody({
              name: `Concurrente A ${suffix}`,
              documentType: CustomerDocumentType.PASSPORT,
              documentNumber,
            }),
          ),
        request(app.getHttpServer())
          .post('/api/v1/customers')
          .set('Cookie', sellerCookie)
          .send(
            validCreateBody({
              name: `Concurrente B ${suffix}`,
              documentType: CustomerDocumentType.PASSPORT,
              documentNumber,
            }),
          ),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const winner = first.status === 201 ? first : second;
      createdCustomerIds.push((winner.body as SafeCustomerBody).id);

      const rows = await prisma.customer.findMany({
        where: {
          documentType: CustomerDocumentType.PASSPORT,
          documentNumber,
        },
      });
      expect(rows).toHaveLength(1);
    }, 60000);
  });

  // ================================================================
  // 7. Listado, paginación, búsqueda, filtros
  // ================================================================
  describe('GET /customers — listado', () => {
    it('estructura paginada por defecto (page=1, limit=20)', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/customers')
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeCustomerBody>;
      expect(Object.keys(body).sort()).toEqual(
        ['data', 'page', 'limit', 'total', 'totalPages'].sort(),
      );
      expect(body.page).toBe(1);
      expect(body.limit).toBe(20);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('page/limit explícitos', async () => {
      await createCustomer(adminCookie);
      await createCustomer(adminCookie);

      const response = await request(app.getHttpServer())
        .get('/api/v1/customers')
        .query({ page: 1, limit: 1 })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeCustomerBody>;
      expect(body.limit).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.total).toBeGreaterThanOrEqual(2);
      expect(body.totalPages).toBeGreaterThanOrEqual(2);
    });
  });

  describe('GET /customers — búsqueda', () => {
    it('búsqueda case-insensitive por name/tradeName/contactName/email/phone/documentNumber', async () => {
      const suffix = nextSuffix();
      const token = `Tok${suffix}`;
      const created = await createCustomer(adminCookie, {
        name: `Cliente Buscable ${token}`,
        tradeName: `Comercial ${token}`,
        contactName: `Contacto ${token}`,
        email: `search.${suffix}@example.com`,
        phone: `PH${suffix}`,
        documentType: CustomerDocumentType.OTHER,
        documentNumber: `SRCH${suffix}`,
      });

      async function searchFor(term: string): Promise<string[]> {
        const response = await request(app.getHttpServer())
          .get('/api/v1/customers')
          .query({ search: term })
          .set('Cookie', adminCookie);
        expect(response.status).toBe(200);
        const body = response.body as PaginatedBody<SafeCustomerBody>;
        return body.data.map((row) => row.id);
      }

      expect(await searchFor(token.toLowerCase())).toContain(created.id);
      expect(await searchFor(`comercial ${token}`.toUpperCase())).toContain(
        created.id,
      );
      expect(await searchFor(`contacto ${token}`)).toContain(created.id);
      expect(
        await searchFor(`SEARCH.${suffix}@EXAMPLE.COM`.toLowerCase()),
      ).toContain(created.id);
      expect(await searchFor(`ph${suffix}`)).toContain(created.id);
      expect(await searchFor(`srch${suffix}`.toLowerCase())).toContain(
        created.id,
      );
    });

    it('búsqueda de solo espacios se comporta como sin filtro', async () => {
      const withoutSearch = await request(app.getHttpServer())
        .get('/api/v1/customers')
        .set('Cookie', adminCookie);
      const withWhitespaceSearch = await request(app.getHttpServer())
        .get('/api/v1/customers')
        .query({ search: '   ' })
        .set('Cookie', adminCookie);

      expect(withoutSearch.status).toBe(200);
      expect(withWhitespaceSearch.status).toBe(200);
      expect(
        (withWhitespaceSearch.body as PaginatedBody<SafeCustomerBody>).total,
      ).toBe((withoutSearch.body as PaginatedBody<SafeCustomerBody>).total);
    });
  });

  describe('GET /customers — filtros', () => {
    it('filtra por status/customerType/customerStage/documentType', async () => {
      const suffix = nextSuffix();
      const created = await createCustomer(adminCookie, {
        customerType: CustomerType.COMPANY,
        customerStage: CustomerStage.CUSTOMER,
        documentType: CustomerDocumentType.RUC,
        documentNumber: `RUC${suffix}`,
      });

      const byStatus = await request(app.getHttpServer())
        .get('/api/v1/customers')
        .query({ status: CustomerStatus.ACTIVE })
        .set('Cookie', adminCookie);
      expect(
        (byStatus.body as PaginatedBody<SafeCustomerBody>).data.some(
          (row) => row.id === created.id,
        ),
      ).toBe(true);

      const byType = await request(app.getHttpServer())
        .get('/api/v1/customers')
        .query({ customerType: CustomerType.COMPANY, search: `RUC${suffix}` })
        .set('Cookie', adminCookie);
      expect(
        (byType.body as PaginatedBody<SafeCustomerBody>).data.some(
          (row) => row.id === created.id,
        ),
      ).toBe(true);

      const byStage = await request(app.getHttpServer())
        .get('/api/v1/customers')
        .query({
          customerStage: CustomerStage.CUSTOMER,
          search: `RUC${suffix}`,
        })
        .set('Cookie', adminCookie);
      expect(
        (byStage.body as PaginatedBody<SafeCustomerBody>).data.some(
          (row) => row.id === created.id,
        ),
      ).toBe(true);

      const byDocType = await request(app.getHttpServer())
        .get('/api/v1/customers')
        .query({
          documentType: CustomerDocumentType.RUC,
          search: `RUC${suffix}`,
        })
        .set('Cookie', adminCookie);
      expect(
        (byDocType.body as PaginatedBody<SafeCustomerBody>).data.some(
          (row) => row.id === created.id,
        ),
      ).toBe(true);
    });

    it('filtra por isGeneric=true y devuelve el genérico estructuralmente (no por nombre)', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/customers')
        .query({ isGeneric: 'true' })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeCustomerBody>;
      const generic = body.data.find((row) => row.id === genericCustomerId);
      expect(generic).toBeDefined();
      expect(generic?.isGeneric).toBe(true);
      for (const row of body.data) {
        expect(row.isGeneric).toBe(true);
      }
    });
  });

  // ================================================================
  // 8. Visibilidad SELLER
  // ================================================================
  describe('visibilidad SELLER', () => {
    let activeId: string;
    let blockedId: string;
    let inactiveId: string;

    beforeAll(async () => {
      const active = await createCustomer(adminCookie);
      activeId = active.id;

      const toBlock = await createCustomer(adminCookie);
      const blocked = await request(app.getHttpServer())
        .post(`/api/v1/customers/${toBlock.id}/block`)
        .set('Cookie', adminCookie);
      expect(blocked.status).toBe(200);
      blockedId = toBlock.id;

      const toDeactivate = await createCustomer(adminCookie);
      const deactivated = await request(app.getHttpServer())
        .post(`/api/v1/customers/${toDeactivate.id}/deactivate`)
        .set('Cookie', adminCookie);
      expect(deactivated.status).toBe(200);
      inactiveId = toDeactivate.id;
    });

    it('LIST: ACTIVE y BLOCKED visibles; INACTIVE ausente', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/customers')
        .query({ limit: 100 })
        .set('Cookie', sellerCookie);
      expect(response.status).toBe(200);
      const ids = (response.body as PaginatedBody<SafeCustomerBody>).data.map(
        (row) => row.id,
      );
      expect(ids).toContain(activeId);
      expect(ids).toContain(blockedId);
      expect(ids).not.toContain(inactiveId);
    });

    it('LIST con status=INACTIVE explícito: 200 con data vacía', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/customers')
        .query({ status: CustomerStatus.INACTIVE })
        .set('Cookie', sellerCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeCustomerBody>;
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('DETAIL: ACTIVE -> 200, BLOCKED -> 200, INACTIVE -> 404', async () => {
      expect(
        (
          await request(app.getHttpServer())
            .get(`/api/v1/customers/${activeId}`)
            .set('Cookie', sellerCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app.getHttpServer())
            .get(`/api/v1/customers/${blockedId}`)
            .set('Cookie', sellerCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app.getHttpServer())
            .get(`/api/v1/customers/${inactiveId}`)
            .set('Cookie', sellerCookie)
        ).status,
      ).toBe(404);
    });

    it('ADMIN/MANAGEMENT sí ven INACTIVE en detalle', async () => {
      expect(
        (
          await request(app.getHttpServer())
            .get(`/api/v1/customers/${inactiveId}`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app.getHttpServer())
            .get(`/api/v1/customers/${inactiveId}`)
            .set('Cookie', managementCookie)
        ).status,
      ).toBe(200);
    });
  });

  // ================================================================
  // 9. Actualización
  // ================================================================
  describe('PATCH /customers/:id — actualización', () => {
    it('actualiza campos mutables con normalización y respuesta segura', async () => {
      const created = await createCustomer(adminCookie);
      const suffix = nextSuffix();

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/customers/${created.id}`)
        .set('Cookie', adminCookie)
        .send({
          name: `  Nombre Actualizado ${suffix}  `,
          tradeName: `Comercial Act ${suffix}`,
          contactName: `Contacto Act ${suffix}`,
          email: `  UPDATED.${suffix}@EXAMPLE.COM  `,
          phone: `UPD${suffix}`,
          address: `Direccion ${suffix}`,
          internalNotes: `Notas ${suffix}`,
          documentType: CustomerDocumentType.DNI,
          documentNumber: `  upd-${suffix}  `,
        });

      expect(response.status).toBe(200);
      const body = response.body as SafeCustomerBody;
      expect(Object.keys(body).sort()).toEqual(SAFE_CUSTOMER_KEYS);
      expect(body.name).toBe(`Nombre Actualizado ${suffix}`);
      expect(body.email).toBe(`updated.${suffix}@example.com`);
      expect(body.documentNumber).toBe(`UPD-${suffix}`.toUpperCase());
      expect(body.documentType).toBe(CustomerDocumentType.DNI);

      const row = await prisma.customer.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.email).toBe(`updated.${suffix}@example.com`);
    });

    it('par de documento: solo documentType -> 400', async () => {
      const created = await createCustomer(adminCookie);
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/customers/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ documentType: CustomerDocumentType.DNI });
      expect(response.status).toBe(400);
    });

    it('par de documento: solo documentNumber -> 400', async () => {
      const created = await createCustomer(adminCookie);
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/customers/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ documentNumber: '12345678' });
      expect(response.status).toBe(400);
    });

    it('ambos null limpia el par; ambos con valor lo reemplaza', async () => {
      const suffix = nextSuffix();
      const created = await createCustomer(adminCookie, {
        documentType: CustomerDocumentType.DNI,
        documentNumber: `CLR${suffix}`,
      });

      const cleared = await request(app.getHttpServer())
        .patch(`/api/v1/customers/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ documentType: null, documentNumber: null });
      expect(cleared.status).toBe(200);
      expect((cleared.body as SafeCustomerBody).documentType).toBeNull();
      expect((cleared.body as SafeCustomerBody).documentNumber).toBeNull();

      const replaced = await request(app.getHttpServer())
        .patch(`/api/v1/customers/${created.id}`)
        .set('Cookie', adminCookie)
        .send({
          documentType: CustomerDocumentType.CE,
          documentNumber: `NEW${suffix}`,
        });
      expect(replaced.status).toBe(200);
      expect((replaced.body as SafeCustomerBody).documentType).toBe(
        CustomerDocumentType.CE,
      );
      expect((replaced.body as SafeCustomerBody).documentNumber).toBe(
        `NEW${suffix}`,
      );
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
      'campo prohibido "%s" es rechazado con 400 (ValidationPipe real)',
      async (field) => {
        const created = await createCustomer(adminCookie);
        const response = await request(app.getHttpServer())
          .patch(`/api/v1/customers/${created.id}`)
          .set('Cookie', adminCookie)
          .send({ name: 'Nombre válido', [field]: 'valor-arbitrario' });
        expect(response.status).toBe(400);
      },
    );

    it('body vacío -> 400 (rechazado por el servicio)', async () => {
      const created = await createCustomer(adminCookie);
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/customers/${created.id}`)
        .set('Cookie', adminCookie)
        .send({});
      expect(response.status).toBe(400);
    });
  });

  // ================================================================
  // 9.5. Contrato de respuesta segura — cobertura completa de las 17 claves
  // (create/update ya se verifican en sus propios describe; aquí se
  // completa list item, detail, una acción de estado exitosa y
  // convert-to-customer, con igualdad exacta de claves, no solo presencia).
  // ================================================================
  describe('contrato de respuesta segura — 17 claves exactas', () => {
    it('list item expone exactamente las 17 claves', async () => {
      const created = await createCustomer(adminCookie);
      const response = await request(app.getHttpServer())
        .get('/api/v1/customers')
        .query({ search: created.name })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeCustomerBody>;
      const item = body.data.find((row) => row.id === created.id);
      expect(item).toBeDefined();
      expect(Object.keys(item as SafeCustomerBody).sort()).toEqual(
        SAFE_CUSTOMER_KEYS,
      );
    });

    it('detail expone exactamente las 17 claves', async () => {
      const created = await createCustomer(adminCookie);
      const response = await request(app.getHttpServer())
        .get(`/api/v1/customers/${created.id}`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      expect(Object.keys(response.body as object).sort()).toEqual(
        SAFE_CUSTOMER_KEYS,
      );
    });

    it('una acción de estado exitosa (deactivate) expone exactamente las 17 claves', async () => {
      const created = await createCustomer(adminCookie);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/customers/${created.id}/deactivate`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      expect(Object.keys(response.body as object).sort()).toEqual(
        SAFE_CUSTOMER_KEYS,
      );
    });

    it('convert-to-customer expone exactamente las 17 claves', async () => {
      const created = await createCustomer(adminCookie, {
        customerStage: CustomerStage.PROSPECT,
      });
      const response = await request(app.getHttpServer())
        .post(`/api/v1/customers/${created.id}/convert-to-customer`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      expect(Object.keys(response.body as object).sort()).toEqual(
        SAFE_CUSTOMER_KEYS,
      );
    });
  });

  // ================================================================
  // 10. Protecciones del cliente genérico
  // ================================================================
  describe('Público general — protecciones', () => {
    it('GET/list exponen el genérico estructuralmente (isGeneric=true, code=PUBLIC_GENERAL, customerType null, stage CUSTOMER, status ACTIVE)', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/customers/${genericCustomerId}`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as SafeCustomerBody;
      expect(body.isGeneric).toBe(true);
      expect(body.code).toBe(TEST_GENERIC_CODE);
      expect(body.customerType).toBeNull();
      expect(body.customerStage).toBe(CustomerStage.CUSTOMER);
      expect(body.status).toBe(CustomerStatus.ACTIVE);
    });

    it('POST normal no puede crear otro genérico: isGeneric/code son rechazados por el ValidationPipe', async () => {
      const isGenericAttempt = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ isGeneric: true }));
      expect(isGenericAttempt.status).toBe(400);

      const codeAttempt = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ code: 'PUBLIC_GENERAL' }));
      expect(codeAttempt.status).toBe(400);

      const nullTypeAttempt = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ customerType: null }));
      expect(nullTypeAttempt.status).toBe(400);
    });

    it('toda mutación sobre la fila real del genérico responde 409 y no la altera', async () => {
      const before = await prisma.customer.findUniqueOrThrow({
        where: { id: genericCustomerId },
      });
      const auditCountBefore = await prisma.auditLog.count({
        where: { entityType: 'Customer', entityId: genericCustomerId },
      });

      const server = app.getHttpServer();
      const patch = await request(server)
        .patch(`/api/v1/customers/${genericCustomerId}`)
        .set('Cookie', adminCookie)
        .send({ phone: '999999999' });
      expect(patch.status).toBe(409);

      const activate = await request(server)
        .post(`/api/v1/customers/${genericCustomerId}/activate`)
        .set('Cookie', adminCookie);
      expect(activate.status).toBe(409);

      const deactivate = await request(server)
        .post(`/api/v1/customers/${genericCustomerId}/deactivate`)
        .set('Cookie', adminCookie);
      expect(deactivate.status).toBe(409);

      const block = await request(server)
        .post(`/api/v1/customers/${genericCustomerId}/block`)
        .set('Cookie', adminCookie);
      expect(block.status).toBe(409);

      const unblock = await request(server)
        .post(`/api/v1/customers/${genericCustomerId}/unblock`)
        .set('Cookie', adminCookie);
      expect(unblock.status).toBe(409);

      const convert = await request(server)
        .post(`/api/v1/customers/${genericCustomerId}/convert-to-customer`)
        .set('Cookie', adminCookie);
      expect(convert.status).toBe(409);

      const after = await prisma.customer.findUniqueOrThrow({
        where: { id: genericCustomerId },
      });
      expect(after.status).toBe(before.status);
      expect(after.customerStage).toBe(before.customerStage);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

      const auditCountAfter = await prisma.auditLog.count({
        where: { entityType: 'Customer', entityId: genericCustomerId },
      });
      expect(auditCountAfter).toBe(auditCountBefore);
    });
  });

  // ================================================================
  // 11. Máquina de estados
  // ================================================================
  describe('máquina de estados', () => {
    it('ACTIVE -> INACTIVE (deactivate) -> ACTIVE (activate)', async () => {
      const created = await createCustomer(adminCookie);

      const deactivated = await request(app.getHttpServer())
        .post(`/api/v1/customers/${created.id}/deactivate`)
        .set('Cookie', adminCookie);
      expect(deactivated.status).toBe(200);
      expect((deactivated.body as SafeCustomerBody).status).toBe(
        CustomerStatus.INACTIVE,
      );
      let row = await prisma.customer.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.status).toBe(CustomerStatus.INACTIVE);

      const activated = await request(app.getHttpServer())
        .post(`/api/v1/customers/${created.id}/activate`)
        .set('Cookie', adminCookie);
      expect(activated.status).toBe(200);
      expect((activated.body as SafeCustomerBody).status).toBe(
        CustomerStatus.ACTIVE,
      );
      row = await prisma.customer.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.status).toBe(CustomerStatus.ACTIVE);
    });

    it('ACTIVE -> BLOCKED (block) -> ACTIVE (unblock)', async () => {
      const created = await createCustomer(adminCookie);

      const blocked = await request(app.getHttpServer())
        .post(`/api/v1/customers/${created.id}/block`)
        .set('Cookie', adminCookie);
      expect(blocked.status).toBe(200);
      expect((blocked.body as SafeCustomerBody).status).toBe(
        CustomerStatus.BLOCKED,
      );
      let row = await prisma.customer.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.status).toBe(CustomerStatus.BLOCKED);

      const unblocked = await request(app.getHttpServer())
        .post(`/api/v1/customers/${created.id}/unblock`)
        .set('Cookie', adminCookie);
      expect(unblocked.status).toBe(200);
      expect((unblocked.body as SafeCustomerBody).status).toBe(
        CustomerStatus.ACTIVE,
      );
      row = await prisma.customer.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.status).toBe(CustomerStatus.ACTIVE);
    });

    async function createWithStatus(status: CustomerStatus): Promise<string> {
      const created = await createCustomer(adminCookie);
      if (status === CustomerStatus.INACTIVE) {
        await request(app.getHttpServer())
          .post(`/api/v1/customers/${created.id}/deactivate`)
          .set('Cookie', adminCookie);
      } else if (status === CustomerStatus.BLOCKED) {
        await request(app.getHttpServer())
          .post(`/api/v1/customers/${created.id}/block`)
          .set('Cookie', adminCookie);
      }
      return created.id;
    }

    it.each([
      ['activate', CustomerStatus.ACTIVE],
      ['activate', CustomerStatus.BLOCKED],
      ['deactivate', CustomerStatus.INACTIVE],
      ['deactivate', CustomerStatus.BLOCKED],
      ['block', CustomerStatus.BLOCKED],
      ['block', CustomerStatus.INACTIVE],
      ['unblock', CustomerStatus.ACTIVE],
      ['unblock', CustomerStatus.INACTIVE],
    ])('%s desde %s -> 409', async (action, fromStatus) => {
      const id = await createWithStatus(fromStatus);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/customers/${id}/${action}`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(409);
    });
  });

  // ================================================================
  // 12. Conversión de etapa
  // ================================================================
  describe('conversión de etapa', () => {
    it('PROSPECT -> CUSTOMER (200); segunda conversión -> 409', async () => {
      const created = await createCustomer(adminCookie, {
        customerStage: CustomerStage.PROSPECT,
      });

      const first = await request(app.getHttpServer())
        .post(`/api/v1/customers/${created.id}/convert-to-customer`)
        .set('Cookie', adminCookie);
      expect(first.status).toBe(200);
      expect((first.body as SafeCustomerBody).customerStage).toBe(
        CustomerStage.CUSTOMER,
      );

      const second = await request(app.getHttpServer())
        .post(`/api/v1/customers/${created.id}/convert-to-customer`)
        .set('Cookie', adminCookie);
      expect(second.status).toBe(409);
    });

    it('cliente creado directamente como CUSTOMER: conversión -> 409', async () => {
      const created = await createCustomer(adminCookie, {
        customerStage: CustomerStage.CUSTOMER,
      });
      const response = await request(app.getHttpServer())
        .post(`/api/v1/customers/${created.id}/convert-to-customer`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(409);
    });

    it('genérico: conversión -> 409', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/customers/${genericCustomerId}/convert-to-customer`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(409);
    });
  });

  // ================================================================
  // 13. Auditoría — mutaciones exitosas
  // ================================================================
  describe('auditoría — mutaciones exitosas', () => {
    it('CUSTOMER_CREATED: metadata exacta, sin PII', async () => {
      const suffix = nextSuffix();
      const created = await createCustomer(adminCookie, {
        name: `Auditoria Creado ${suffix}`,
        email: `audit.created.${suffix}@example.com`,
        documentType: CustomerDocumentType.DNI,
        documentNumber: `AUD${suffix}`,
      });

      const rows = await fetchAuditRows(
        AuditAction.CUSTOMER_CREATED,
        created.id,
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.module).toBe('CUSTOMERS');
      expect(row.userId).toBe(adminId);
      assertAuditRowHasNoSecrets(row);
      const metadata = row.metadata as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual(
        ['customerType', 'customerStage', 'documentType'].sort(),
      );
      const serialized = JSON.stringify(metadata);
      expect(serialized).not.toContain(`AUD${suffix}`);
      expect(serialized).not.toContain(`Auditoria Creado ${suffix}`);
      expect(serialized).not.toContain(`audit.created.${suffix}`);
    });

    it('CUSTOMER_UPDATED: metadata contiene solo updatedFields (nombres, no valores)', async () => {
      const suffix = nextSuffix();
      const created = await createCustomer(adminCookie);

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/customers/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ phone: `PHONE${suffix}`, email: `upd.${suffix}@example.com` });
      expect(response.status).toBe(200);

      const rows = await fetchAuditRows(
        AuditAction.CUSTOMER_UPDATED,
        created.id,
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      assertAuditRowHasNoSecrets(row);
      const metadata = row.metadata as { updatedFields: string[] };
      expect(Object.keys(metadata)).toEqual(['updatedFields']);
      expect(metadata.updatedFields.sort()).toEqual(['email', 'phone'].sort());
      const serialized = JSON.stringify(metadata);
      expect(serialized).not.toContain(`PHONE${suffix}`);
      expect(serialized).not.toContain(`upd.${suffix}`);
    });

    it.each([
      ['deactivate', AuditAction.CUSTOMER_DEACTIVATED, CustomerStatus.ACTIVE],
      ['block', AuditAction.CUSTOMER_BLOCKED, CustomerStatus.ACTIVE],
    ])(
      '%s: audita previousStatus exacto',
      async (action, auditAction, expectedPrevious) => {
        const created = await createCustomer(adminCookie);
        const response = await request(app.getHttpServer())
          .post(`/api/v1/customers/${created.id}/${action}`)
          .set('Cookie', adminCookie);
        expect(response.status).toBe(200);

        const rows = await fetchAuditRows(auditAction, created.id);
        expect(rows).toHaveLength(1);
        assertAuditRowHasNoSecrets(rows[0]);
        expect(rows[0].metadata).toEqual({ previousStatus: expectedPrevious });
      },
    );

    it('activate/unblock: audita previousStatus exacto', async () => {
      const created = await createCustomer(adminCookie);
      await request(app.getHttpServer())
        .post(`/api/v1/customers/${created.id}/deactivate`)
        .set('Cookie', adminCookie);
      const activated = await request(app.getHttpServer())
        .post(`/api/v1/customers/${created.id}/activate`)
        .set('Cookie', adminCookie);
      expect(activated.status).toBe(200);
      const activateRows = await fetchAuditRows(
        AuditAction.CUSTOMER_ACTIVATED,
        created.id,
      );
      expect(activateRows).toHaveLength(1);
      expect(activateRows[0].metadata).toEqual({
        previousStatus: CustomerStatus.INACTIVE,
      });

      const created2 = await createCustomer(adminCookie);
      await request(app.getHttpServer())
        .post(`/api/v1/customers/${created2.id}/block`)
        .set('Cookie', adminCookie);
      const unblocked = await request(app.getHttpServer())
        .post(`/api/v1/customers/${created2.id}/unblock`)
        .set('Cookie', adminCookie);
      expect(unblocked.status).toBe(200);
      const unblockRows = await fetchAuditRows(
        AuditAction.CUSTOMER_UNBLOCKED,
        created2.id,
      );
      expect(unblockRows).toHaveLength(1);
      expect(unblockRows[0].metadata).toEqual({
        previousStatus: CustomerStatus.BLOCKED,
      });
    });

    it('CUSTOMER_STAGE_CHANGED: audita previousStage y customerStage exactos', async () => {
      const created = await createCustomer(adminCookie, {
        customerStage: CustomerStage.PROSPECT,
      });
      const response = await request(app.getHttpServer())
        .post(`/api/v1/customers/${created.id}/convert-to-customer`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);

      const rows = await fetchAuditRows(
        AuditAction.CUSTOMER_STAGE_CHANGED,
        created.id,
      );
      expect(rows).toHaveLength(1);
      assertAuditRowHasNoSecrets(rows[0]);
      expect(rows[0].metadata).toEqual({
        previousStage: CustomerStage.PROSPECT,
        customerStage: CustomerStage.CUSTOMER,
      });
    });
  });

  // ================================================================
  // 14. Atomicidad de operaciones fallidas
  // ================================================================
  describe('atomicidad — operaciones fallidas', () => {
    it('transición de estado inválida: fila sin cambios, sin AuditLog nuevo', async () => {
      const created = await createCustomer(adminCookie);
      const before = await prisma.customer.findUniqueOrThrow({
        where: { id: created.id },
      });
      const auditBefore = await prisma.auditLog.count({
        where: { entityType: 'Customer', entityId: created.id },
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/customers/${created.id}/activate`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(409);

      const after = await prisma.customer.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(after.status).toBe(before.status);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

      const auditAfter = await prisma.auditLog.count({
        where: { entityType: 'Customer', entityId: created.id },
      });
      expect(auditAfter).toBe(auditBefore);
    });

    it('mutación de genérico rechazada: sin cambios, sin AuditLog (cubierto también en protecciones)', async () => {
      const before = await prisma.customer.findUniqueOrThrow({
        where: { id: genericCustomerId },
      });
      const response = await request(app.getHttpServer())
        .post(`/api/v1/customers/${genericCustomerId}/block`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(409);
      const after = await prisma.customer.findUniqueOrThrow({
        where: { id: genericCustomerId },
      });
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });

    it('conversión de etapa inválida: fila sin cambios, sin AuditLog nuevo', async () => {
      const created = await createCustomer(adminCookie, {
        customerStage: CustomerStage.CUSTOMER,
      });
      const before = await prisma.customer.findUniqueOrThrow({
        where: { id: created.id },
      });
      const auditBefore = await prisma.auditLog.count({
        where: { entityType: 'Customer', entityId: created.id },
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/customers/${created.id}/convert-to-customer`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(409);

      const after = await prisma.customer.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(after.customerStage).toBe(before.customerStage);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

      const auditAfter = await prisma.auditLog.count({
        where: { entityType: 'Customer', entityId: created.id },
      });
      expect(auditAfter).toBe(auditBefore);
    });
  });

  // ================================================================
  // 15. Restricciones reales de PostgreSQL (bypass del servicio)
  // ================================================================
  describe('restricciones reales de PostgreSQL', () => {
    it('customers_document_pair rechaza mitad de par (documentType sin documentNumber)', async () => {
      const suffix = nextSuffix();
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO customers
              (id, customer_type, customer_stage, document_type, document_number, name, is_generic, status, updated_at)
            VALUES
              (gen_random_uuid(), 'PERSON', 'PROSPECT', 'DNI', NULL, ${`Check Pair ${suffix}`}, false, 'ACTIVE', now())
          `,
        '23514',
      );
    });

    it('customers_name_not_blank rechaza nombre en blanco', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO customers
              (id, customer_type, customer_stage, name, is_generic, status, updated_at)
            VALUES
              (gen_random_uuid(), 'PERSON', 'PROSPECT', '   ', false, 'ACTIVE', now())
          `,
        '23514',
      );
    });

    it('customers_type_generic_consistency rechaza cliente normal sin customerType', async () => {
      const suffix = nextSuffix();
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO customers
              (id, customer_type, customer_stage, name, is_generic, status, updated_at)
            VALUES
              (gen_random_uuid(), NULL, 'PROSPECT', ${`Check Type ${suffix}`}, false, 'ACTIVE', now())
          `,
        '23514',
      );
    });

    it('customers_generic_no_document rechaza genérico con documento', async () => {
      const suffix = nextSuffix();
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO customers
              (id, code, customer_type, customer_stage, document_type, document_number, name, is_generic, status, updated_at)
            VALUES
              (gen_random_uuid(), 'PUBLIC_GENERAL', NULL, 'CUSTOMER', 'DNI', ${`DOC${suffix}`}, 'Check Generic Doc', true, 'ACTIVE', now())
          `,
        '23514',
      );
    });

    it('customers_generic_stage_status rechaza genérico con stage distinto de CUSTOMER', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO customers
              (id, code, customer_type, customer_stage, name, is_generic, status, updated_at)
            VALUES
              (gen_random_uuid(), 'PUBLIC_GENERAL', NULL, 'PROSPECT', 'Check Generic Stage', true, 'ACTIVE', now())
          `,
        '23514',
      );
    });

    it('customers_generic_code_consistency rechaza genérico con code distinto de PUBLIC_GENERAL', async () => {
      const suffix = nextSuffix();
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO customers
              (id, code, customer_type, customer_stage, name, is_generic, status, updated_at)
            VALUES
              (gen_random_uuid(), ${`OTHER_CODE_${suffix}`}, NULL, 'CUSTOMER', 'Check Generic Code', true, 'ACTIVE', now())
          `,
        '23514',
      );
    });

    it('la conexión sigue siendo utilizable tras los rechazos anteriores', async () => {
      const result = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
      expect(result[0].ok).toBe(1);
    });
  });

  // ================================================================
  // 16. UNIQUE(code) — prueba directa
  // ================================================================
  describe('UNIQUE(code) — prueba directa', () => {
    it('code duplicado entre dos clientes normales -> 23505', async () => {
      const suffix = nextSuffix();
      const code = `TEST_CODE_${suffix}`;
      const first = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.PROSPECT,
          name: `Code Owner ${suffix}`,
          code,
          isGeneric: false,
          status: CustomerStatus.ACTIVE,
        },
      });
      directInsertIds.push(first.id);

      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO customers
              (id, code, customer_type, customer_stage, name, is_generic, status, updated_at)
            VALUES
              (gen_random_uuid(), ${code}, 'PERSON', 'PROSPECT', ${`Code Dup ${suffix}`}, false, 'ACTIVE', now())
          `,
        '23505',
      );

      await prisma.customer.delete({ where: { id: first.id } });
      directInsertIds.splice(directInsertIds.indexOf(first.id), 1);
    });

    it('múltiples clientes normales con code=null son permitidos', async () => {
      const suffix = nextSuffix();
      const a = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.PROSPECT,
          name: `Null Code A ${suffix}`,
          code: null,
          isGeneric: false,
          status: CustomerStatus.ACTIVE,
        },
      });
      const b = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.PROSPECT,
          name: `Null Code B ${suffix}`,
          code: null,
          isGeneric: false,
          status: CustomerStatus.ACTIVE,
        },
      });
      directInsertIds.push(a.id, b.id);

      await prisma.customer.deleteMany({ where: { id: { in: [a.id, b.id] } } });
      directInsertIds.splice(directInsertIds.indexOf(a.id), 1);
      directInsertIds.splice(directInsertIds.indexOf(b.id), 1);
    });
  });

  // ================================================================
  // 17. Índice único funcional de documento — prueba directa
  // ================================================================
  describe('customers_document_unique — prueba directa', () => {
    let baseId: string;
    let baseDocumentNumber: string;

    beforeAll(async () => {
      const suffix = nextSuffix();
      baseDocumentNumber = `ABC${suffix}`;
      const base = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.PROSPECT,
          name: `Documento Base ${suffix}`,
          documentType: CustomerDocumentType.DNI,
          documentNumber: baseDocumentNumber,
          isGeneric: false,
          status: CustomerStatus.ACTIVE,
        },
      });
      baseId = base.id;
      directInsertIds.push(baseId);
    });

    afterAll(async () => {
      await prisma.customer.delete({ where: { id: baseId } });
      const index = directInsertIds.indexOf(baseId);
      if (index !== -1) {
        directInsertIds.splice(index, 1);
      }
    });

    it('mismo case exacto -> 23505', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO customers
              (id, customer_type, customer_stage, document_type, document_number, name, is_generic, status, updated_at)
            VALUES
              (gen_random_uuid(), 'PERSON', 'PROSPECT', 'DNI', ${baseDocumentNumber}, 'Documento Duplicado A', false, 'ACTIVE', now())
          `,
        '23505',
      );
    });

    it('minúsculas (UPPER) -> 23505', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO customers
              (id, customer_type, customer_stage, document_type, document_number, name, is_generic, status, updated_at)
            VALUES
              (gen_random_uuid(), 'PERSON', 'PROSPECT', 'DNI', ${baseDocumentNumber.toLowerCase()}, 'Documento Duplicado B', false, 'ACTIVE', now())
          `,
        '23505',
      );
    });

    it('con espacios perimetrales (BTRIM) -> 23505', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO customers
              (id, customer_type, customer_stage, document_type, document_number, name, is_generic, status, updated_at)
            VALUES
              (gen_random_uuid(), 'PERSON', 'PROSPECT', 'DNI', ${' ' + baseDocumentNumber + ' '}, 'Documento Duplicado C', false, 'ACTIVE', now())
          `,
        '23505',
      );
    });

    it('minúsculas con espacios (UPPER + BTRIM combinados) -> 23505', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO customers
              (id, customer_type, customer_stage, document_type, document_number, name, is_generic, status, updated_at)
            VALUES
              (gen_random_uuid(), 'PERSON', 'PROSPECT', 'DNI', ${' ' + baseDocumentNumber.toLowerCase() + ' '}, 'Documento Duplicado D', false, 'ACTIVE', now())
          `,
        '23505',
      );
    });

    it('mismo documentNumber con distinto documentType es permitido', async () => {
      const other = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.PROSPECT,
          name: 'Documento Distinto Tipo',
          documentType: CustomerDocumentType.RUC,
          documentNumber: baseDocumentNumber,
          isGeneric: false,
          status: CustomerStatus.ACTIVE,
        },
      });
      directInsertIds.push(other.id);
      await prisma.customer.delete({ where: { id: other.id } });
      directInsertIds.splice(directInsertIds.indexOf(other.id), 1);
    });

    it('múltiples clientes sin documento son permitidos', async () => {
      const a = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.PROSPECT,
          name: 'Sin Documento A',
          isGeneric: false,
          status: CustomerStatus.ACTIVE,
        },
      });
      const b = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.PROSPECT,
          name: 'Sin Documento B',
          isGeneric: false,
          status: CustomerStatus.ACTIVE,
        },
      });
      directInsertIds.push(a.id, b.id);
      await prisma.customer.deleteMany({ where: { id: { in: [a.id, b.id] } } });
      directInsertIds.splice(directInsertIds.indexOf(a.id), 1);
      directInsertIds.splice(directInsertIds.indexOf(b.id), 1);
    });
  });

  // ================================================================
  // 18. Seguridad de errores HTTP
  // ================================================================
  describe('seguridad de errores HTTP', () => {
    it('400/404/409 no exponen detalles internos', async () => {
      const badRequest = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ documentType: CustomerDocumentType.DNI }));
      expect(badRequest.status).toBe(400);
      assertNoLeakage(badRequest);

      const notFound = await request(app.getHttpServer())
        .get(`/api/v1/customers/${NON_EXISTENT_UUID}`)
        .set('Cookie', adminCookie);
      expect(notFound.status).toBe(404);
      assertNoLeakage(notFound);

      const suffix = nextSuffix();
      const documentNumber = `SAFE${suffix}`;
      await createCustomer(adminCookie, {
        documentType: CustomerDocumentType.DNI,
        documentNumber,
      });
      const conflict = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            documentType: CustomerDocumentType.DNI,
            documentNumber,
          }),
        );
      expect(conflict.status).toBe(409);
      assertNoLeakage(conflict);
    });
  });

  // ================================================================
  // 19. Validación de UUID
  // ================================================================
  describe('validación de UUID', () => {
    it('GET /customers/not-a-uuid -> 400', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/customers/not-a-uuid')
        .set('Cookie', adminCookie);
      expect(response.status).toBe(400);
    });
  });

  // ================================================================
  // 20. Sin DELETE/PUT
  // ================================================================
  describe('superficie de rutas — inmutabilidad', () => {
    it('DELETE /customers/:id no existe (404)', async () => {
      const created = await createCustomer(adminCookie);
      const response = await request(app.getHttpServer())
        .delete(`/api/v1/customers/${created.id}`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(404);

      const stillThere = await prisma.customer.findUnique({
        where: { id: created.id },
      });
      expect(stillThere).not.toBeNull();
    });

    it('PUT /customers/:id no existe (404)', async () => {
      const created = await createCustomer(adminCookie);
      const response = await request(app.getHttpServer())
        .put(`/api/v1/customers/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ name: 'x' });
      expect(response.status).toBe(404);
    });
  });

  // ================================================================
  // 21. Regresión de Swagger
  // ================================================================
  describe('regresión de Swagger', () => {
    it('el documento OpenAPI conserva exactamente las 9 operaciones de Customers en 7 paths, sin DELETE', async () => {
      const response = await request(app.getHttpServer()).get('/api/docs-json');
      expect(response.status).toBe(200);

      const document = response.body as {
        paths: Record<string, Record<string, unknown>>;
        tags: { name: string }[];
      };
      expect(document.tags.map((tag) => tag.name)).toContain('Customers');

      const customerPaths = Object.keys(document.paths).filter((path) =>
        path.includes('/customers'),
      );
      expect(customerPaths).toHaveLength(7);

      let totalOperations = 0;
      for (const path of customerPaths) {
        const methods = Object.keys(document.paths[path]);
        totalOperations += methods.length;
        expect(methods).not.toContain('delete');
        expect(methods).not.toContain('put');
      }
      expect(totalOperations).toBe(9);
    });
  });
});

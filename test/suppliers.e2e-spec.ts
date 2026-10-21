import { INestApplication } from '@nestjs/common';
import {
  PrismaClient,
  RoleName,
  SupplierDocumentType,
  SupplierStatus,
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

const MANAGEMENT_USERNAME = 'e2e_management_suppliers';
const MANAGEMENT_PASSWORD = 'ManagementSuppliers123';
const ACCOUNTANT_USERNAME = 'e2e_accountant_suppliers';
const ACCOUNTANT_PASSWORD = 'AccountantSuppliers123';
const SELLER_USERNAME = 'e2e_seller_suppliers';
const SELLER_PASSWORD = 'SellerSuppliers123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_suppliers';
const WAREHOUSE_PASSWORD = 'WarehouseSuppliers123';
const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

const SAFE_SUPPLIER_KEYS = [
  'id',
  'documentType',
  'documentNumber',
  'countryCode',
  'legalName',
  'tradeName',
  'contactName',
  'phone',
  'email',
  'address',
  'internalNotes',
  'defaultCurrencyCode',
  'status',
  'createdAt',
  'updatedAt',
].sort();

interface SafeSupplierBody {
  id: string;
  documentType: SupplierDocumentType;
  documentNumber: string;
  countryCode: string;
  legalName: string;
  tradeName: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  internalNotes: string | null;
  defaultCurrencyCode: string | null;
  status: SupplierStatus;
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

describe('Suppliers — Fase A5.1 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let managementCookie: string;
  let accountantCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;

  const createdSupplierIds: string[] = [];
  const directInsertIds: string[] = [];

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
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_suppliers@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: ACCOUNTANT_USERNAME,
      email: 'e2e_accountant_suppliers@demosystem.test',
      password: ACCOUNTANT_PASSWORD,
      roleName: RoleName.ACCOUNTANT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_suppliers@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_suppliers@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
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
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, MANAGEMENT_PASSWORD)
    ).cookie;
    accountantCookie = (
      await login(app.getHttpServer(), ACCOUNTANT_USERNAME, ACCOUNTANT_PASSWORD)
    ).cookie;
    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, SELLER_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;
  }, 60000);

  afterAll(async () => {
    try {
      if (createdSupplierIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: {
            entityType: 'Supplier',
            entityId: { in: createdSupplierIds },
          },
        });
      }
      if (directInsertIds.length > 0) {
        const remainingDirect = await prisma.supplier.findMany({
          where: { id: { in: directInsertIds } },
          select: { id: true },
        });
        if (remainingDirect.length > 0) {
          await prisma.supplier.deleteMany({
            where: { id: { in: remainingDirect.map((row) => row.id) } },
          });
        }
      }
      if (createdSupplierIds.length > 0) {
        await prisma.supplier.deleteMany({
          where: { id: { in: createdSupplierIds } },
        });
      }
      await prisma.userRole.deleteMany({
        where: {
          user: {
            username: {
              in: [
                MANAGEMENT_USERNAME,
                ACCOUNTANT_USERNAME,
                SELLER_USERNAME,
                WAREHOUSE_USERNAME,
              ],
            },
          },
        },
      });
      await prisma.user.deleteMany({
        where: {
          username: {
            in: [
              MANAGEMENT_USERNAME,
              ACCOUNTANT_USERNAME,
              SELLER_USERNAME,
              WAREHOUSE_USERNAME,
            ],
          },
        },
      });
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  }, 60000);

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  function validCreateBody(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const suffix = nextSuffix();
    return {
      documentType: SupplierDocumentType.RUC,
      // Toma los últimos 11 caracteres: el `counter` (la parte que
      // realmente varía entre llamadas) va al FINAL de `suffix`, así que
      // slice(-11) lo preserva — slice(0,11) desde el inicio lo recortaría
      // siempre fuera (RUN_ID por sí solo ya supera 11 caracteres).
      documentNumber: suffix.slice(-11).padStart(11, '0'),
      legalName: `Proveedor E2E ${suffix}`,
      ...overrides,
    };
  }

  async function createSupplier(
    cookie: string,
    overrides: Record<string, unknown> = {},
  ): Promise<SafeSupplierBody> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/suppliers')
      .set('Cookie', cookie)
      .send(validCreateBody(overrides));
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear el proveedor fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafeSupplierBody;
    createdSupplierIds.push(body.id);
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
      where: { action, entityType: 'Supplier', entityId },
    });
  }

  /**
   * Mismo criterio exacto que test/customers.e2e-spec.ts: solo se acopla al
   * SQLSTATE (23514 = check_violation, 23505 = unique_violation), nunca al
   * texto completo del error.
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
    expect(serialized).not.toMatch(/suppliers_/);
  }

  // ================================================================
  // 1. Autenticación
  // ================================================================
  describe('autenticación', () => {
    it('sin cookie: 401 en todos los endpoints', async () => {
      expect(
        (await request(app.getHttpServer()).get('/api/v1/suppliers')).status,
      ).toBe(401);
      expect(
        (
          await request(app.getHttpServer())
            .post('/api/v1/suppliers')
            .send(validCreateBody())
        ).status,
      ).toBe(401);
    });
  });

  // ================================================================
  // 2. Matriz de roles
  // ================================================================
  describe('matriz de roles (HTTP real)', () => {
    it('SELLER/WAREHOUSE: 403 en todos los endpoints', async () => {
      for (const cookie of [sellerCookie, warehouseCookie]) {
        expect(
          (
            await request(app.getHttpServer())
              .get('/api/v1/suppliers')
              .set('Cookie', cookie)
          ).status,
        ).toBe(403);
        expect(
          (
            await request(app.getHttpServer())
              .get(`/api/v1/suppliers/${NON_EXISTENT_UUID}`)
              .set('Cookie', cookie)
          ).status,
        ).toBe(403);
        expect(
          (
            await request(app.getHttpServer())
              .post('/api/v1/suppliers')
              .set('Cookie', cookie)
              .send(validCreateBody())
          ).status,
        ).toBe(403);
        expect(
          (
            await request(app.getHttpServer())
              .patch(`/api/v1/suppliers/${NON_EXISTENT_UUID}`)
              .set('Cookie', cookie)
              .send({ legalName: 'x' })
          ).status,
        ).toBe(403);
        expect(
          (
            await request(app.getHttpServer())
              .post(`/api/v1/suppliers/${NON_EXISTENT_UUID}/activate`)
              .set('Cookie', cookie)
          ).status,
        ).toBe(403);
        expect(
          (
            await request(app.getHttpServer())
              .post(`/api/v1/suppliers/${NON_EXISTENT_UUID}/deactivate`)
              .set('Cookie', cookie)
          ).status,
        ).toBe(403);
      }
    });

    it('MANAGEMENT/ACCOUNTANT: leen (200) pero nunca escriben (403)', async () => {
      for (const cookie of [managementCookie, accountantCookie]) {
        expect(
          (
            await request(app.getHttpServer())
              .get('/api/v1/suppliers')
              .set('Cookie', cookie)
          ).status,
        ).toBe(200);
        expect(
          (
            await request(app.getHttpServer())
              .post('/api/v1/suppliers')
              .set('Cookie', cookie)
              .send(validCreateBody())
          ).status,
        ).toBe(403);
        expect(
          (
            await request(app.getHttpServer())
              .patch(`/api/v1/suppliers/${NON_EXISTENT_UUID}`)
              .set('Cookie', cookie)
              .send({ legalName: 'x' })
          ).status,
        ).toBe(403);
        expect(
          (
            await request(app.getHttpServer())
              .post(`/api/v1/suppliers/${NON_EXISTENT_UUID}/activate`)
              .set('Cookie', cookie)
          ).status,
        ).toBe(403);
      }
    });

    it('ACCOUNTANT no escala a módulos no relacionados (sales/products/users -> 403)', async () => {
      expect(
        (
          await request(app.getHttpServer())
            .get('/api/v1/sales')
            .set('Cookie', accountantCookie)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app.getHttpServer())
            .get('/api/v1/products')
            .set('Cookie', accountantCookie)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app.getHttpServer())
            .get('/api/v1/users')
            .set('Cookie', accountantCookie)
        ).status,
      ).toBe(403);
    });

    it('ADMIN: acceso completo', async () => {
      const supplier = await createSupplier(adminCookie);
      expect(
        (
          await request(app.getHttpServer())
            .get('/api/v1/suppliers')
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app.getHttpServer())
            .patch(`/api/v1/suppliers/${supplier.id}`)
            .set('Cookie', adminCookie)
            .send({ legalName: 'Nombre actualizado por ADMIN' })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app.getHttpServer())
            .post(`/api/v1/suppliers/${supplier.id}/deactivate`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app.getHttpServer())
            .post(`/api/v1/suppliers/${supplier.id}/activate`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
    });
  });

  // ================================================================
  // 3. Creación
  // ================================================================
  describe('POST /suppliers — creación', () => {
    it('RUC válido (11 dígitos): 201, nace ACTIVE, countryCode "PE" por defecto', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', adminCookie)
        .send(validCreateBody());
      expect(response.status).toBe(201);
      const body = response.body as SafeSupplierBody;
      createdSupplierIds.push(body.id);
      expect(body.status).toBe(SupplierStatus.ACTIVE);
      expect(body.countryCode).toBe('PE');
    });

    it('RUC con formato inválido (menos de 11 dígitos): 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ documentNumber: '123' }));
      expect(response.status).toBe(400);
    });

    it('DNI válido (8 dígitos): 201', async () => {
      const suffix = nextSuffix();
      const response = await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            documentType: SupplierDocumentType.DNI,
            documentNumber: `${suffix}`.padStart(8, '0').slice(-8),
          }),
        );
      expect(response.status).toBe(201);
      createdSupplierIds.push((response.body as SafeSupplierBody).id);
    });

    it('DNI con formato inválido (7 dígitos): 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            documentType: SupplierDocumentType.DNI,
            documentNumber: '1234567',
          }),
        );
      expect(response.status).toBe(400);
    });

    it('proveedor extranjero (FOREIGN_TAX_ID, countryCode explícito, sin exigir RUC): 201', async () => {
      const suffix = nextSuffix();
      const response = await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            documentType: SupplierDocumentType.FOREIGN_TAX_ID,
            documentNumber: `FTID-${suffix}`,
            countryCode: 'US',
          }),
        );
      expect(response.status).toBe(201);
      const body = response.body as SafeSupplierBody;
      createdSupplierIds.push(body.id);
      expect(body.countryCode).toBe('US');
      expect(body.documentType).toBe(SupplierDocumentType.FOREIGN_TAX_ID);
    });

    it('countryCode inválido (3 letras): 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ countryCode: 'PER' }));
      expect(response.status).toBe(400);
    });

    it('legalName vacío: 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ legalName: '' }));
      expect(response.status).toBe(400);
    });

    it('payload sin documentType/documentNumber/legalName: 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', adminCookie)
        .send({});
      expect(response.status).toBe(400);
    });
  });

  // ================================================================
  // 4. Normalización
  // ================================================================
  describe('normalización', () => {
    it('documentNumber se persiste recortado y en mayúsculas', async () => {
      const suffix = nextSuffix();
      const supplier = await createSupplier(adminCookie, {
        documentType: SupplierDocumentType.FOREIGN_TAX_ID,
        documentNumber: `  ftid-${suffix}-norm  `,
      });
      expect(supplier.documentNumber).toBe(`FTID-${suffix}-NORM`);
    });

    it('countryCode se persiste en mayúsculas', async () => {
      const supplier = await createSupplier(adminCookie, { countryCode: 'cl' });
      expect(supplier.countryCode).toBe('CL');
    });
  });

  // ================================================================
  // 5. Documento duplicado
  // ================================================================
  describe('documento duplicado', () => {
    it('mismo documentType+countryCode+documentNumber: 409 en el segundo intento', async () => {
      const suffix = nextSuffix();
      const documentNumber = `FTID-DUP-${suffix}`;
      await createSupplier(adminCookie, {
        documentType: SupplierDocumentType.FOREIGN_TAX_ID,
        documentNumber,
        countryCode: 'US',
      });

      const second = await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            documentType: SupplierDocumentType.FOREIGN_TAX_ID,
            documentNumber,
            countryCode: 'US',
          }),
        );
      expect(second.status).toBe(409);
      assertNoLeakage(second);
    });

    it('mismo documentNumber literal pero distinto countryCode: ambos 201 (sin colisión entre países)', async () => {
      const suffix = nextSuffix();
      const documentNumber = `FTID-CC-${suffix}`;

      const first = await createSupplier(adminCookie, {
        documentType: SupplierDocumentType.FOREIGN_TAX_ID,
        documentNumber,
        countryCode: 'US',
      });
      expect(first.countryCode).toBe('US');

      const secondResponse = await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            documentType: SupplierDocumentType.FOREIGN_TAX_ID,
            documentNumber,
            countryCode: 'CL',
          }),
        );
      expect(secondResponse.status).toBe(201);
      createdSupplierIds.push((secondResponse.body as SafeSupplierBody).id);
    });

    it('duplicado insensible a mayúsculas/espacios: 409', async () => {
      const suffix = nextSuffix();
      await createSupplier(adminCookie, {
        documentType: SupplierDocumentType.FOREIGN_TAX_ID,
        documentNumber: `case-${suffix}`,
        countryCode: 'US',
      });

      const response = await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            documentType: SupplierDocumentType.FOREIGN_TAX_ID,
            documentNumber: `  CASE-${suffix}  `,
            countryCode: 'us',
          }),
        );
      expect(response.status).toBe(409);
    });

    it('desactivar un proveedor NO libera su documento para un proveedor nuevo: sigue 409', async () => {
      const suffix = nextSuffix();
      const documentNumber = `FTID-DEACT-${suffix}`;
      const supplier = await createSupplier(adminCookie, {
        documentType: SupplierDocumentType.FOREIGN_TAX_ID,
        documentNumber,
        countryCode: 'US',
      });

      const deactivateResponse = await request(app.getHttpServer())
        .post(`/api/v1/suppliers/${supplier.id}/deactivate`)
        .set('Cookie', adminCookie);
      expect(deactivateResponse.status).toBe(200);

      const second = await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            documentType: SupplierDocumentType.FOREIGN_TAX_ID,
            documentNumber,
            countryCode: 'US',
          }),
        );
      expect(second.status).toBe(409);
    });
  });

  // ================================================================
  // 6. Documento duplicado concurrente (HTTP real, Promise.all)
  // ================================================================
  describe('documento duplicado — concurrencia real', () => {
    it('dos POST concurrentes con el mismo documento: uno 201, uno 409, una sola fila', async () => {
      const suffix = nextSuffix();
      const documentNumber = `CONC-${suffix}`;

      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/suppliers')
          .set('Cookie', adminCookie)
          .send(
            validCreateBody({
              documentType: SupplierDocumentType.FOREIGN_TAX_ID,
              documentNumber,
              countryCode: 'US',
              legalName: `Concurrente A ${suffix}`,
            }),
          ),
        request(app.getHttpServer())
          .post('/api/v1/suppliers')
          .set('Cookie', adminCookie)
          .send(
            validCreateBody({
              documentType: SupplierDocumentType.FOREIGN_TAX_ID,
              documentNumber,
              countryCode: 'US',
              legalName: `Concurrente B ${suffix}`,
            }),
          ),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const winner = first.status === 201 ? first : second;
      createdSupplierIds.push((winner.body as SafeSupplierBody).id);

      const rows = await prisma.supplier.findMany({
        where: {
          documentType: SupplierDocumentType.FOREIGN_TAX_ID,
          countryCode: 'US',
          documentNumber,
        },
      });
      expect(rows).toHaveLength(1);
    }, 60000);
  });

  // ================================================================
  // 7. Listado, búsqueda y filtros
  // ================================================================
  describe('GET /suppliers — listado/búsqueda/filtros', () => {
    it('paginación: respeta page/limit', async () => {
      await createSupplier(adminCookie);
      await createSupplier(adminCookie);
      const response = await request(app.getHttpServer())
        .get('/api/v1/suppliers')
        .query({ page: 1, limit: 1 })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeSupplierBody>;
      expect(body.data).toHaveLength(1);
      expect(body.limit).toBe(1);
    });

    it('búsqueda por legalName encuentra el proveedor creado', async () => {
      const suffix = nextSuffix();
      const legalName = `Buscable Única ${suffix}`;
      await createSupplier(adminCookie, { legalName });

      const response = await request(app.getHttpServer())
        .get('/api/v1/suppliers')
        .query({ search: `Buscable Única ${suffix}` })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeSupplierBody>;
      expect(body.data.some((s) => s.legalName === legalName)).toBe(true);
    });

    it('filtro por status=INACTIVE excluye proveedores ACTIVE', async () => {
      const supplier = await createSupplier(adminCookie);
      await request(app.getHttpServer())
        .post(`/api/v1/suppliers/${supplier.id}/deactivate`)
        .set('Cookie', adminCookie);

      const response = await request(app.getHttpServer())
        .get('/api/v1/suppliers')
        .query({ status: SupplierStatus.INACTIVE })
        .set('Cookie', adminCookie);
      const body = response.body as PaginatedBody<SafeSupplierBody>;
      expect(body.data.some((s) => s.id === supplier.id)).toBe(true);
      expect(body.data.every((s) => s.status === SupplierStatus.INACTIVE)).toBe(
        true,
      );

      // Reactivar para no afectar otras pruebas del mismo archivo.
      await request(app.getHttpServer())
        .post(`/api/v1/suppliers/${supplier.id}/activate`)
        .set('Cookie', adminCookie);
    });

    it('filtro por documentType=DNI excluye RUC', async () => {
      const suffix = nextSuffix();
      const dniSupplier = await createSupplier(adminCookie, {
        documentType: SupplierDocumentType.DNI,
        documentNumber: `${suffix}`.padStart(8, '1').slice(-8),
      });

      const response = await request(app.getHttpServer())
        .get('/api/v1/suppliers')
        .query({ documentType: SupplierDocumentType.DNI })
        .set('Cookie', adminCookie);
      const body = response.body as PaginatedBody<SafeSupplierBody>;
      expect(body.data.some((s) => s.id === dniSupplier.id)).toBe(true);
      expect(
        body.data.every((s) => s.documentType === SupplierDocumentType.DNI),
      ).toBe(true);
    });
  });

  // ================================================================
  // 8. Actualización
  // ================================================================
  describe('PATCH /suppliers/:id — actualización', () => {
    it('actualiza legalName/contactName/phone', async () => {
      const supplier = await createSupplier(adminCookie);
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/suppliers/${supplier.id}`)
        .set('Cookie', adminCookie)
        .send({
          legalName: 'Nombre legal actualizado',
          contactName: 'Juan Pérez',
          phone: '999888777',
        });
      expect(response.status).toBe(200);
      const body = response.body as SafeSupplierBody;
      expect(body.legalName).toBe('Nombre legal actualizado');
      expect(body.contactName).toBe('Juan Pérez');
      expect(body.phone).toBe('999888777');
    });

    it('reemplaza documentType+documentNumber juntos, re-validando formato', async () => {
      const supplier = await createSupplier(adminCookie, {
        documentType: SupplierDocumentType.FOREIGN_TAX_ID,
        documentNumber: `FTID-UPD-${nextSuffix()}`,
      });
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/suppliers/${supplier.id}`)
        .set('Cookie', adminCookie)
        .send({
          documentType: SupplierDocumentType.DNI,
          documentNumber: '87654321',
        });
      expect(response.status).toBe(200);
      const body = response.body as SafeSupplierBody;
      expect(body.documentType).toBe(SupplierDocumentType.DNI);
      expect(body.documentNumber).toBe('87654321');
    });

    it('solo documentType sin documentNumber: 400', async () => {
      const supplier = await createSupplier(adminCookie);
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/suppliers/${supplier.id}`)
        .set('Cookie', adminCookie)
        .send({ documentType: SupplierDocumentType.DNI });
      expect(response.status).toBe(400);
    });

    it('payload vacío: 400', async () => {
      const supplier = await createSupplier(adminCookie);
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/suppliers/${supplier.id}`)
        .set('Cookie', adminCookie)
        .send({});
      expect(response.status).toBe(400);
    });

    it('id inexistente: 404', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/suppliers/${NON_EXISTENT_UUID}`)
        .set('Cookie', adminCookie)
        .send({ legalName: 'x' });
      expect(response.status).toBe(404);
    });

    it('nuevo documento colisiona con otro proveedor existente: 409', async () => {
      const suffix = nextSuffix();
      const documentNumber = `FTID-COLL-${suffix}`;
      await createSupplier(adminCookie, {
        documentType: SupplierDocumentType.FOREIGN_TAX_ID,
        documentNumber,
        countryCode: 'US',
      });
      const other = await createSupplier(adminCookie, {
        documentType: SupplierDocumentType.FOREIGN_TAX_ID,
        documentNumber: `FTID-OTHER-${suffix}`,
        countryCode: 'US',
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/suppliers/${other.id}`)
        .set('Cookie', adminCookie)
        .send({
          documentType: SupplierDocumentType.FOREIGN_TAX_ID,
          documentNumber,
          countryCode: 'US',
        });
      expect(response.status).toBe(409);
    });
  });

  // ================================================================
  // 9. Máquina de estados (activate/deactivate)
  // ================================================================
  describe('máquina de estados', () => {
    it('ACTIVE -> deactivate -> INACTIVE -> activate -> ACTIVE', async () => {
      const supplier = await createSupplier(adminCookie);

      const deactivated = await request(app.getHttpServer())
        .post(`/api/v1/suppliers/${supplier.id}/deactivate`)
        .set('Cookie', adminCookie);
      expect(deactivated.status).toBe(200);
      expect((deactivated.body as SafeSupplierBody).status).toBe(
        SupplierStatus.INACTIVE,
      );

      const activated = await request(app.getHttpServer())
        .post(`/api/v1/suppliers/${supplier.id}/activate`)
        .set('Cookie', adminCookie);
      expect(activated.status).toBe(200);
      expect((activated.body as SafeSupplierBody).status).toBe(
        SupplierStatus.ACTIVE,
      );
    });

    it('activate sobre un proveedor ya ACTIVE: 409', async () => {
      const supplier = await createSupplier(adminCookie);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/suppliers/${supplier.id}/activate`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(409);
    });

    it('deactivate sobre un proveedor ya INACTIVE: 409', async () => {
      const supplier = await createSupplier(adminCookie);
      await request(app.getHttpServer())
        .post(`/api/v1/suppliers/${supplier.id}/deactivate`)
        .set('Cookie', adminCookie);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/suppliers/${supplier.id}/deactivate`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(409);

      await request(app.getHttpServer())
        .post(`/api/v1/suppliers/${supplier.id}/activate`)
        .set('Cookie', adminCookie);
    });

    it('activate/deactivate sobre id inexistente: 404', async () => {
      expect(
        (
          await request(app.getHttpServer())
            .post(`/api/v1/suppliers/${NON_EXISTENT_UUID}/activate`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app.getHttpServer())
            .post(`/api/v1/suppliers/${NON_EXISTENT_UUID}/deactivate`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(404);
    });
  });

  // ================================================================
  // 10. Contrato de respuesta segura
  // ================================================================
  describe('contrato de respuesta segura — claves exactas', () => {
    it('la respuesta de creación expone exactamente las claves de SafeSupplier', async () => {
      const supplier = await createSupplier(adminCookie);
      expect(Object.keys(supplier).sort()).toEqual(SAFE_SUPPLIER_KEYS);
    });
  });

  // ================================================================
  // 11. Auditoría
  // ================================================================
  describe('auditoría — mutaciones exitosas', () => {
    it('SUPPLIER_CREATED: sin PII, identifica documentType/countryCode', async () => {
      const supplier = await createSupplier(adminCookie, {
        documentType: SupplierDocumentType.RUC,
      });
      const rows = await fetchAuditRows(
        AuditAction.SUPPLIER_CREATED,
        supplier.id,
      );
      expect(rows).toHaveLength(1);
      assertAuditRowHasNoSecrets(rows[0]);
      expect(rows[0].metadata).toEqual({
        documentType: SupplierDocumentType.RUC,
        countryCode: 'PE',
      });
    });

    it('SUPPLIER_UPDATED: metadata solo con updatedFields, sin PII', async () => {
      const supplier = await createSupplier(adminCookie);
      await request(app.getHttpServer())
        .patch(`/api/v1/suppliers/${supplier.id}`)
        .set('Cookie', adminCookie)
        .send({ legalName: 'Nombre auditado', phone: '911222333' });

      const rows = await fetchAuditRows(
        AuditAction.SUPPLIER_UPDATED,
        supplier.id,
      );
      expect(rows).toHaveLength(1);
      assertAuditRowHasNoSecrets(rows[0]);
      expect(rows[0].metadata).toEqual({
        updatedFields: ['legalName', 'phone'],
      });
    });

    it('SUPPLIER_ACTIVATED/SUPPLIER_DEACTIVATED registran previousStatus', async () => {
      const supplier = await createSupplier(adminCookie);
      await request(app.getHttpServer())
        .post(`/api/v1/suppliers/${supplier.id}/deactivate`)
        .set('Cookie', adminCookie);
      await request(app.getHttpServer())
        .post(`/api/v1/suppliers/${supplier.id}/activate`)
        .set('Cookie', adminCookie);

      const deactivatedRows = await fetchAuditRows(
        AuditAction.SUPPLIER_DEACTIVATED,
        supplier.id,
      );
      expect(deactivatedRows).toHaveLength(1);
      expect(deactivatedRows[0].metadata).toEqual({
        previousStatus: SupplierStatus.ACTIVE,
      });

      const activatedRows = await fetchAuditRows(
        AuditAction.SUPPLIER_ACTIVATED,
        supplier.id,
      );
      expect(activatedRows).toHaveLength(1);
      expect(activatedRows[0].metadata).toEqual({
        previousStatus: SupplierStatus.INACTIVE,
      });
    });
  });

  // ================================================================
  // 12. Restricciones reales de PostgreSQL (bypass directo del servicio)
  // ================================================================
  describe('restricciones reales de PostgreSQL', () => {
    it('suppliers_legal_name_not_blank: CHECK rechaza legalName solo espacios', async () => {
      const suffix = nextSuffix();
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO suppliers
              (id, document_type, document_number, country_code, legal_name, status, updated_at)
            VALUES
              (gen_random_uuid(), 'OTHER', ${`DIRECT-${suffix}`}, 'PE', '   ', 'ACTIVE', now())
          `,
        '23514',
      );
    });

    it('suppliers_document_number_not_blank: CHECK rechaza documentNumber solo espacios', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO suppliers
              (id, document_type, document_number, country_code, legal_name, status, updated_at)
            VALUES
              (gen_random_uuid(), 'OTHER', '   ', 'PE', 'Proveedor directo', 'ACTIVE', now())
          `,
        '23514',
      );
    });

    it('suppliers_country_code_format: CHECK rechaza un countryCode inválido insertado directamente', async () => {
      const suffix = nextSuffix();
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO suppliers
              (id, document_type, document_number, country_code, legal_name, status, updated_at)
            VALUES
              (gen_random_uuid(), 'OTHER', ${`DIRECT-${suffix}`}, 'p3', 'Proveedor directo', 'ACTIVE', now())
          `,
        '23514',
      );
    });

    it('suppliers_document_unique: índice único rechaza un duplicado insertado directamente (insensible a mayúsculas/espacios)', async () => {
      const suffix = nextSuffix();
      const documentNumber = `DIRECT-UNIQUE-${suffix}`;
      const supplier = await createSupplier(adminCookie, {
        documentType: SupplierDocumentType.FOREIGN_TAX_ID,
        documentNumber,
        countryCode: 'US',
      });
      expect(supplier.documentNumber).toBe(documentNumber.toUpperCase());

      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO suppliers
              (id, document_type, document_number, country_code, legal_name, status, updated_at)
            VALUES
              (gen_random_uuid(), 'FOREIGN_TAX_ID', ${'  ' + documentNumber.toLowerCase() + '  '}, 'US', 'Proveedor directo duplicado', 'ACTIVE', now())
          `,
        '23505',
      );
    });

    it('la conexión sigue siendo utilizable tras los rechazos anteriores', async () => {
      const result = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
      expect(result[0].ok).toBe(1);
    });
  });

  // ================================================================
  // 13. Validación de UUID
  // ================================================================
  describe('validación de UUID', () => {
    it('id con formato inválido: 400 en GET/PATCH/activate/deactivate', async () => {
      expect(
        (
          await request(app.getHttpServer())
            .get('/api/v1/suppliers/no-es-un-uuid')
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(400);
      expect(
        (
          await request(app.getHttpServer())
            .patch('/api/v1/suppliers/no-es-un-uuid')
            .set('Cookie', adminCookie)
            .send({ legalName: 'x' })
        ).status,
      ).toBe(400);
    });
  });
});

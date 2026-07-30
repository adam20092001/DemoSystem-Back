import { INestApplication } from '@nestjs/common';
import {
  PrismaClient,
  ProductType,
  RoleName,
  UnitStatus,
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

const SELLER_USERNAME = 'e2e_seller_units';
const SELLER_PASSWORD = 'SellerUnits123';

/**
 * Unit.code es VarChar(15) en el esquema: un timestamp completo (13 dígitos)
 * más un prefijo descriptivo lo desbordaría. Base36 mantiene el sufijo en
 * 8 caracteres, dejando espacio de sobra para prefijos cortos.
 */
function suffix(): string {
  return Date.now().toString(36).toUpperCase();
}

interface SafeUnitBody {
  id: string;
  code: string;
  name: string;
  abbreviation: string;
  allowDecimal: boolean;
  status: UnitStatus;
}

describe('Units (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let sellerCookie: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_units@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
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
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('autorización', () => {
    it('sin cookie responde 401', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/units');
      expect(response.status).toBe(401);
    });

    it('SELLER no puede crear (403)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/units')
        .set('Cookie', sellerCookie)
        .send({
          code: `NOPE_${suffix()}`,
          name: 'No debería crearse',
          abbreviation: 'nd',
        });

      expect(response.status).toBe(403);
    });
  });

  describe('POST /units', () => {
    it('crea la unidad y normaliza code/abbreviation a mayúsculas', async () => {
      const s = suffix();
      // Sin espacios: @Matches en abbreviation los rechazaría antes de que el
      // servicio llegue a normalizar (el trim ocurre después de la validación
      // del DTO, no antes). Aquí se ejercita la conversión a mayúsculas.
      const response = await request(app.getHttpServer())
        .post('/api/v1/units')
        .set('Cookie', adminCookie)
        .send({ code: `uni_${s}`, name: `Unidad ${s}`, abbreviation: `u${s}` });

      expect(response.status).toBe(201);
      const body = response.body as SafeUnitBody;
      expect(body.code).toBe(`UNI_${s}`.toUpperCase());
      expect(body.abbreviation).toBe(`U${s}`.toUpperCase());
      expect(body.status).toBe(UnitStatus.ACTIVE);

      const rows = await prisma.auditLog.findMany({
        where: { action: AuditAction.UNIT_CREATED, entityId: body.id },
      });
      expect(rows).toHaveLength(1);
      assertAuditRowHasNoSecrets(rows[0]);
    });

    it('code duplicado responde 409', async () => {
      const s = suffix();
      const code = `DUP_${s}`;
      const first = await request(app.getHttpServer())
        .post('/api/v1/units')
        .set('Cookie', adminCookie)
        .send({ code, name: `Primera ${s}`, abbreviation: 'p1' });
      expect(first.status).toBe(201);

      const second = await request(app.getHttpServer())
        .post('/api/v1/units')
        .set('Cookie', adminCookie)
        .send({ code, name: `Segunda ${s}`, abbreviation: 'p2' });

      expect(second.status).toBe(409);
    });

    it('allowDecimal=true y allowDecimal=false se respetan tal cual', async () => {
      const s = suffix();
      const withDecimal = await request(app.getHttpServer())
        .post('/api/v1/units')
        .set('Cookie', adminCookie)
        .send({
          code: `DECT_${s}`,
          name: 'Con decimal',
          abbreviation: 'cd',
          allowDecimal: true,
        });
      const withoutDecimal = await request(app.getHttpServer())
        .post('/api/v1/units')
        .set('Cookie', adminCookie)
        .send({
          code: `DECF_${s}`,
          name: 'Sin decimal',
          abbreviation: 'sd',
          allowDecimal: false,
        });

      expect((withDecimal.body as SafeUnitBody).allowDecimal).toBe(true);
      expect((withoutDecimal.body as SafeUnitBody).allowDecimal).toBe(false);
    });
  });

  describe('GET /units — filtro allowDecimal', () => {
    it('allowDecimal=false filtra correctamente', async () => {
      const s = suffix();
      await request(app.getHttpServer())
        .post('/api/v1/units')
        .set('Cookie', adminCookie)
        .send({
          code: `FILT_${s}`,
          name: 'Filtro true',
          abbreviation: 'ft',
          allowDecimal: true,
        });
      const created = await request(app.getHttpServer())
        .post('/api/v1/units')
        .set('Cookie', adminCookie)
        .send({
          code: `FILF_${s}`,
          name: 'Filtro false',
          abbreviation: 'ff',
          allowDecimal: false,
        });

      const response = await request(app.getHttpServer())
        .get('/api/v1/units')
        .query({ allowDecimal: 'false', search: `FIL` })
        .set('Cookie', adminCookie);

      expect(response.status).toBe(200);
      const body = response.body as { data: SafeUnitBody[] };
      expect(body.data.every((u) => u.allowDecimal === false)).toBe(true);
      expect(
        body.data.some((u) => u.id === (created.body as SafeUnitBody).id),
      ).toBe(true);
    });

    it('un valor booleano inválido responde 400', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/units')
        .query({ allowDecimal: 'yes' })
        .set('Cookie', adminCookie);

      expect(response.status).toBe(400);
    });
  });

  describe('visibilidad por rol', () => {
    it('SELLER siempre ve solo ACTIVE aunque pida status=INACTIVE', async () => {
      const s = suffix();
      const created = await request(app.getHttpServer())
        .post('/api/v1/units')
        .set('Cookie', adminCookie)
        .send({
          code: `SELU_${s}`,
          name: `Unidad seller ${s}`,
          abbreviation: 'su',
        });
      const id = (created.body as SafeUnitBody).id;
      await request(app.getHttpServer())
        .post(`/api/v1/units/${id}/deactivate`)
        .set('Cookie', adminCookie);

      const response = await request(app.getHttpServer())
        .get('/api/v1/units')
        .query({ status: UnitStatus.INACTIVE })
        .set('Cookie', sellerCookie);

      expect(response.status).toBe(200);
      const body = response.body as { data: SafeUnitBody[] };
      expect(body.data.find((u) => u.id === id)).toBeUndefined();
    });

    it('detalle INACTIVE oculto a SELLER (404)', async () => {
      const s = suffix();
      const created = await request(app.getHttpServer())
        .post('/api/v1/units')
        .set('Cookie', adminCookie)
        .send({
          code: `HIDU_${s}`,
          name: `Unidad oculta ${s}`,
          abbreviation: 'hu',
        });
      const id = (created.body as SafeUnitBody).id;
      await request(app.getHttpServer())
        .post(`/api/v1/units/${id}/deactivate`)
        .set('Cookie', adminCookie);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/units/${id}`)
        .set('Cookie', sellerCookie);

      expect(response.status).toBe(404);
    });
  });

  describe('activar/desactivar', () => {
    it('desactiva y activa correctamente, registrando ambas auditorías', async () => {
      const s = suffix();
      const created = await request(app.getHttpServer())
        .post('/api/v1/units')
        .set('Cookie', adminCookie)
        .send({ code: `TOG_${s}`, name: `Toggle ${s}`, abbreviation: 'tg' });
      const id = (created.body as SafeUnitBody).id;

      const deactivated = await request(app.getHttpServer())
        .post(`/api/v1/units/${id}/deactivate`)
        .set('Cookie', adminCookie);
      expect(deactivated.status).toBe(200);
      expect((deactivated.body as SafeUnitBody).status).toBe(
        UnitStatus.INACTIVE,
      );

      const activated = await request(app.getHttpServer())
        .post(`/api/v1/units/${id}/activate`)
        .set('Cookie', adminCookie);
      expect(activated.status).toBe(200);
      expect((activated.body as SafeUnitBody).status).toBe(UnitStatus.ACTIVE);

      const deactivatedRows = await prisma.auditLog.findMany({
        where: { action: AuditAction.UNIT_DEACTIVATED, entityId: id },
      });
      const activatedRows = await prisma.auditLog.findMany({
        where: { action: AuditAction.UNIT_ACTIVATED, entityId: id },
      });
      expect(deactivatedRows).toHaveLength(1);
      expect(activatedRows).toHaveLength(1);
    });

    it('bloquea la desactivación si existe un producto ACTIVE con esta unidad', async () => {
      const s = suffix();
      const unit = await request(app.getHttpServer())
        .post('/api/v1/units')
        .set('Cookie', adminCookie)
        .send({
          code: `PU_${s}`,
          name: `Unidad con producto ${s}`,
          abbreviation: 'up',
        });
      const unitId = (unit.body as SafeUnitBody).id;

      const category = await prisma.category.upsert({
        where: { code: 'E2E_UNITCAT' },
        update: {},
        create: { code: 'E2E_UNITCAT', name: 'Categoría e2e unidades' },
      });

      const product = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({
          sku: `SKU_UNIT_${s}`,
          name: `Producto unidad ${s}`,
          productType: ProductType.PRODUCT,
          categoryId: category.id,
          unitId,
          salePrice: '10.00',
          isInventoryTracked: true,
        });
      expect(product.status).toBe(201);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/units/${unitId}/deactivate`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(409);
    });
  });
});

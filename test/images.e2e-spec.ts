import { INestApplication } from '@nestjs/common';
import {
  CategoryStatus,
  PrismaClient,
  ProductType,
  RoleName,
  UnitStatus,
} from '@prisma/client';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
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

const SELLER_USERNAME = 'e2e_seller_images';
const SELLER_PASSWORD = 'SellerImages123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_images';
const WAREHOUSE_PASSWORD = 'WarehouseImages123';
const MANAGEMENT_USERNAME = 'e2e_management_images';
const MANAGEMENT_PASSWORD = 'ManagementImages123';

const VALID_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
]);
const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const VALID_WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP'),
  Buffer.from([0, 0, 0, 0]),
]);
const INVALID_SIGNATURE = Buffer.from('contenido que no es una imagen');

interface SafeProductBody {
  id: string;
}

interface SafeImageBody {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sortOrder: number;
  isPrimary: boolean;
  fileUrl: string;
}

describe('Product Images (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;
  let managementCookie: string;
  let categoryId: string;
  let unitId: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_images@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_images@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_images@demosystem.test',
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

    const category = await prisma.category.upsert({
      where: { code: 'E2E_IMGCAT' },
      update: { status: CategoryStatus.ACTIVE },
      create: { code: 'E2E_IMGCAT', name: 'Categoría e2e imágenes' },
    });
    categoryId = category.id;

    const unit = await prisma.unit.upsert({
      where: { code: 'E2E_IMGUNIT' },
      update: { status: UnitStatus.ACTIVE },
      create: {
        code: 'E2E_IMGUNIT',
        name: 'Unidad e2e imágenes',
        abbreviation: 'eiu',
      },
    });
    unitId = unit.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();

    // Carpeta temporal exclusiva de este archivo (ver test/jest-e2e.setup.ts):
    // nunca la carpeta real de desarrollo.
    const uploadDir = process.env.PRODUCT_UPLOAD_DIR;
    if (uploadDir !== undefined) {
      await rm(uploadDir, { recursive: true, force: true });
    }
  });

  async function createProduct(suffix: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('Cookie', adminCookie)
      .send({
        sku: `sku-img-${suffix}`,
        name: `Producto imágenes ${suffix}`,
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: '10.00',
        isInventoryTracked: true,
      });
    expect(response.status).toBe(201);
    return (response.body as SafeProductBody).id;
  }

  function uploadRequest(productId: string) {
    return request(app.getHttpServer())
      .post(`/api/v1/products/${productId}/images`)
      .set('Cookie', adminCookie);
  }

  async function getStoragePath(imageId: string): Promise<string> {
    const row = await prisma.productImage.findUniqueOrThrow({
      where: { id: imageId },
    });
    return row.storagePath;
  }

  describe('subida', () => {
    it('acepta un JPEG válido y responde 201 con la forma segura', async () => {
      const productId = await createProduct(Date.now());

      const response = await uploadRequest(productId).attach(
        'file',
        VALID_JPEG,
        { filename: 'foto.jpg', contentType: 'image/jpeg' },
      );

      expect(response.status).toBe(201);
      const body = response.body as SafeImageBody;
      expect(body.mimeType).toBe('image/jpeg');
      expect(body.fileUrl).toBe(
        `/api/v1/products/${productId}/images/${body.id}/file`,
      );
      expect(response.body).not.toHaveProperty('storagePath');
    });

    it('acepta un PNG válido', async () => {
      const productId = await createProduct(Date.now() + 1);

      const response = await uploadRequest(productId).attach(
        'file',
        VALID_PNG,
        { filename: 'foto.png', contentType: 'image/png' },
      );

      expect(response.status).toBe(201);
      expect((response.body as SafeImageBody).mimeType).toBe('image/png');
    });

    it('acepta un WebP válido', async () => {
      const productId = await createProduct(Date.now() + 2);

      const response = await uploadRequest(productId).attach(
        'file',
        VALID_WEBP,
        { filename: 'foto.webp', contentType: 'image/webp' },
      );

      expect(response.status).toBe(201);
      expect((response.body as SafeImageBody).mimeType).toBe('image/webp');
    });

    it('la primera imagen queda principal, la segunda no, y solo una fila isPrimary=true existe en PostgreSQL', async () => {
      const productId = await createProduct(Date.now() + 3);

      const first = await uploadRequest(productId).attach('file', VALID_JPEG, {
        filename: 'primera.jpg',
        contentType: 'image/jpeg',
      });
      const second = await uploadRequest(productId).attach('file', VALID_PNG, {
        filename: 'segunda.png',
        contentType: 'image/png',
      });

      expect((first.body as SafeImageBody).isPrimary).toBe(true);
      expect((second.body as SafeImageBody).isPrimary).toBe(false);

      const primaryCount = await prisma.productImage.count({
        where: { productId, isPrimary: true },
      });
      expect(primaryCount).toBe(1);
    });

    it('MIME permitido pero firma binaria inválida responde 400', async () => {
      const productId = await createProduct(Date.now() + 4);

      const response = await uploadRequest(productId).attach(
        'file',
        INVALID_SIGNATURE,
        { filename: 'falso.jpg', contentType: 'image/jpeg' },
      );

      expect(response.status).toBe(400);
    });

    it('firma binaria válida pero MIME declarado incompatible responde 400', async () => {
      const productId = await createProduct(Date.now() + 5);

      const response = await uploadRequest(productId).attach(
        'file',
        VALID_PNG,
        {
          filename: 'confundido.jpg',
          contentType: 'image/jpeg',
        },
      );

      expect(response.status).toBe(400);
    });

    it('MIME no permitido (image/gif) responde 400', async () => {
      const productId = await createProduct(Date.now() + 6);

      const response = await uploadRequest(productId).attach(
        'file',
        Buffer.from([0x47, 0x49, 0x46, 0x38]),
        { filename: 'animado.gif', contentType: 'image/gif' },
      );

      expect(response.status).toBe(400);
    });

    it('archivo ausente responde 400', async () => {
      const productId = await createProduct(Date.now() + 7);

      const response = await uploadRequest(productId).field('sortOrder', '0');

      expect(response.status).toBe(400);
    });

    it('tamaño excedido responde 413', async () => {
      const productId = await createProduct(Date.now() + 8);
      const maxSize = Number(
        process.env.PRODUCT_IMAGE_MAX_SIZE_BYTES ?? '5242880',
      );
      const oversized = Buffer.concat([VALID_JPEG, Buffer.alloc(maxSize, 0)]);

      const response = await uploadRequest(productId).attach(
        'file',
        oversized,
        { filename: 'enorme.jpg', contentType: 'image/jpeg' },
      );

      expect(response.status).toBe(413);
    }, 30000);

    it('un fileName peligroso no provoca path traversal y llega saneado', async () => {
      const productId = await createProduct(Date.now() + 9);

      const response = await uploadRequest(productId).attach(
        'file',
        VALID_JPEG,
        { filename: '../../../etc/passwd.jpg', contentType: 'image/jpeg' },
      );

      expect(response.status).toBe(201);
      const body = response.body as SafeImageBody;
      expect(body.fileName).not.toContain('..');
      expect(body.fileName).not.toContain('/');
      expect(body.fileName).not.toContain('\\');

      const storagePath = await getStoragePath(body.id);
      expect(storagePath.startsWith(productId)).toBe(true);

      const uploadDir = process.env.PRODUCT_UPLOAD_DIR as string;
      const absolutePath = resolve(uploadDir, storagePath);
      expect(absolutePath.startsWith(resolve(uploadDir))).toBe(true);
      expect(existsSync(absolutePath)).toBe(true);
    });

    it('registra PRODUCT_IMAGE_ADDED sin storagePath ni buffer en auditoría', async () => {
      const productId = await createProduct(Date.now() + 10);

      const response = await uploadRequest(productId).attach(
        'file',
        VALID_JPEG,
        {
          filename: 'auditada.jpg',
          contentType: 'image/jpeg',
        },
      );
      const imageId = (response.body as SafeImageBody).id;

      const rows = await prisma.auditLog.findMany({
        where: { action: AuditAction.PRODUCT_IMAGE_ADDED, entityId: productId },
      });
      const row = rows.find(
        (r) => (r.metadata as Record<string, unknown>)?.imageId === imageId,
      );
      expect(row).toBeDefined();
      if (row !== undefined) {
        assertAuditRowHasNoSecrets(row);
        const serialized = JSON.stringify(row).toLowerCase();
        expect(serialized).not.toContain('storagepath');
      }
    });
  });

  describe('imagen principal', () => {
    it('permite establecer otra imagen como principal', async () => {
      const productId = await createProduct(Date.now() + 11);
      const first = await uploadRequest(productId).attach('file', VALID_JPEG, {
        filename: 'a.jpg',
        contentType: 'image/jpeg',
      });
      const second = await uploadRequest(productId).attach('file', VALID_PNG, {
        filename: 'b.png',
        contentType: 'image/png',
      });
      const secondId = (second.body as SafeImageBody).id;

      const response = await request(app.getHttpServer())
        .post(`/api/v1/products/${productId}/images/${secondId}/primary`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(200);
      expect((response.body as SafeImageBody).isPrimary).toBe(true);

      const firstId = (first.body as SafeImageBody).id;
      const refreshedFirst = await prisma.productImage.findUniqueOrThrow({
        where: { id: firstId },
      });
      expect(refreshedFirst.isPrimary).toBe(false);

      const primaryCount = await prisma.productImage.count({
        where: { productId, isPrimary: true },
      });
      expect(primaryCount).toBe(1);

      const changeRows = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.PRODUCT_PRIMARY_IMAGE_CHANGED,
          entityId: productId,
        },
      });
      expect(changeRows.length).toBeGreaterThan(0);
    });

    it('marcar como principal una imagen que ya lo es responde 409', async () => {
      const productId = await createProduct(Date.now() + 12);
      const first = await uploadRequest(productId).attach('file', VALID_JPEG, {
        filename: 'a.jpg',
        contentType: 'image/jpeg',
      });
      const firstId = (first.body as SafeImageBody).id;

      const response = await request(app.getHttpServer())
        .post(`/api/v1/products/${productId}/images/${firstId}/primary`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(409);
    });
  });

  describe('descarga', () => {
    it('devuelve el binario con el Content-Type correcto', async () => {
      const productId = await createProduct(Date.now() + 13);
      const uploaded = await uploadRequest(productId).attach(
        'file',
        VALID_PNG,
        {
          filename: 'descarga.png',
          contentType: 'image/png',
        },
      );
      const imageId = (uploaded.body as SafeImageBody).id;

      const response = await request(app.getHttpServer())
        .get(`/api/v1/products/${productId}/images/${imageId}/file`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('image/png');
    });

    it('SELLER no puede descargar imágenes de un producto INACTIVE (404)', async () => {
      const productId = await createProduct(Date.now() + 14);
      const uploaded = await uploadRequest(productId).attach(
        'file',
        VALID_JPEG,
        {
          filename: 'inactivo.jpg',
          contentType: 'image/jpeg',
        },
      );
      const imageId = (uploaded.body as SafeImageBody).id;

      await request(app.getHttpServer())
        .post(`/api/v1/products/${productId}/deactivate`)
        .set('Cookie', adminCookie);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/products/${productId}/images/${imageId}/file`)
        .set('Cookie', sellerCookie);

      expect(response.status).toBe(404);
    });

    it.each([
      ['WAREHOUSE', () => warehouseCookie],
      ['MANAGEMENT', () => managementCookie],
    ])(
      '%s sí puede descargar imágenes de un producto INACTIVE',
      async (_label, getCookie) => {
        const productId = await createProduct(
          Date.now() + Math.floor(Math.random() * 100000),
        );
        const uploaded = await uploadRequest(productId).attach(
          'file',
          VALID_JPEG,
          {
            filename: 'visible.jpg',
            contentType: 'image/jpeg',
          },
        );
        const imageId = (uploaded.body as SafeImageBody).id;

        await request(app.getHttpServer())
          .post(`/api/v1/products/${productId}/deactivate`)
          .set('Cookie', adminCookie);

        const response = await request(app.getHttpServer())
          .get(`/api/v1/products/${productId}/images/${imageId}/file`)
          .set('Cookie', getCookie());

        expect(response.status).toBe(200);
      },
    );
  });

  describe('eliminación', () => {
    it('borra una imagen no principal sin afectar la principal', async () => {
      const productId = await createProduct(Date.now() + 15);
      const first = await uploadRequest(productId).attach('file', VALID_JPEG, {
        filename: 'principal.jpg',
        contentType: 'image/jpeg',
      });
      const second = await uploadRequest(productId).attach('file', VALID_PNG, {
        filename: 'secundaria.png',
        contentType: 'image/png',
      });
      const firstId = (first.body as SafeImageBody).id;
      const secondId = (second.body as SafeImageBody).id;

      const response = await request(app.getHttpServer())
        .delete(`/api/v1/products/${productId}/images/${secondId}`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(204);

      const refreshedFirst = await prisma.productImage.findUniqueOrThrow({
        where: { id: firstId },
      });
      expect(refreshedFirst.isPrimary).toBe(true);
    });

    it('borrar la imagen principal promueve la siguiente por sortOrder/createdAt', async () => {
      const productId = await createProduct(Date.now() + 16);
      const first = await uploadRequest(productId).attach('file', VALID_JPEG, {
        filename: 'primero.jpg',
        contentType: 'image/jpeg',
      });
      const second = await uploadRequest(productId).attach('file', VALID_PNG, {
        filename: 'segundo.png',
        contentType: 'image/png',
      });
      const firstId = (first.body as SafeImageBody).id;
      const secondId = (second.body as SafeImageBody).id;

      const response = await request(app.getHttpServer())
        .delete(`/api/v1/products/${productId}/images/${firstId}`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(204);

      const promoted = await prisma.productImage.findUniqueOrThrow({
        where: { id: secondId },
      });
      expect(promoted.isPrimary).toBe(true);

      const changeRows = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.PRODUCT_PRIMARY_IMAGE_CHANGED,
          entityId: productId,
        },
      });
      expect(changeRows.length).toBeGreaterThan(0);
    });

    it('borrar la última imagen deja cero imágenes principales', async () => {
      const productId = await createProduct(Date.now() + 17);
      const only = await uploadRequest(productId).attach('file', VALID_JPEG, {
        filename: 'unica.jpg',
        contentType: 'image/jpeg',
      });
      const onlyId = (only.body as SafeImageBody).id;

      const response = await request(app.getHttpServer())
        .delete(`/api/v1/products/${productId}/images/${onlyId}`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(204);

      const primaryCount = await prisma.productImage.count({
        where: { productId, isPrimary: true },
      });
      expect(primaryCount).toBe(0);
    });

    it('el archivo físico se elimina del disco tras el borrado', async () => {
      const productId = await createProduct(Date.now() + 18);
      const uploaded = await uploadRequest(productId).attach(
        'file',
        VALID_JPEG,
        {
          filename: 'a-borrar.jpg',
          contentType: 'image/jpeg',
        },
      );
      const imageId = (uploaded.body as SafeImageBody).id;
      const storagePath = await getStoragePath(imageId);
      const uploadDir = process.env.PRODUCT_UPLOAD_DIR as string;
      const absolutePath = resolve(uploadDir, storagePath);
      expect(existsSync(absolutePath)).toBe(true);

      const response = await request(app.getHttpServer())
        .delete(`/api/v1/products/${productId}/images/${imageId}`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(204);

      expect(existsSync(absolutePath)).toBe(false);
    });

    it('registra PRODUCT_IMAGE_REMOVED sin storagePath', async () => {
      const productId = await createProduct(Date.now() + 19);
      const uploaded = await uploadRequest(productId).attach(
        'file',
        VALID_JPEG,
        {
          filename: 'para-auditar.jpg',
          contentType: 'image/jpeg',
        },
      );
      const imageId = (uploaded.body as SafeImageBody).id;

      await request(app.getHttpServer())
        .delete(`/api/v1/products/${productId}/images/${imageId}`)
        .set('Cookie', adminCookie);

      const rows = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.PRODUCT_IMAGE_REMOVED,
          entityId: productId,
        },
      });
      const row = rows.find(
        (r) => (r.metadata as Record<string, unknown>)?.imageId === imageId,
      );
      expect(row).toBeDefined();
      if (row !== undefined) {
        assertAuditRowHasNoSecrets(row);
        expect(JSON.stringify(row).toLowerCase()).not.toContain('storagepath');
      }
    });
  });

  describe('auditoría — sin datos sensibles en todo el archivo', () => {
    it('ningún registro de audit_logs de este archivo contiene buffer, storagePath ni rutas locales', async () => {
      const rows = await prisma.auditLog.findMany({
        where: {
          action: {
            in: [
              AuditAction.PRODUCT_IMAGE_ADDED,
              AuditAction.PRODUCT_IMAGE_REMOVED,
              AuditAction.PRODUCT_PRIMARY_IMAGE_CHANGED,
            ],
          },
        },
      });
      expect(rows.length).toBeGreaterThan(0);

      for (const row of rows) {
        assertAuditRowHasNoSecrets(row);
        const serialized = JSON.stringify(row).toLowerCase();
        expect(serialized).not.toContain('storagepath');
        expect(serialized).not.toContain('buffer');
        expect(serialized).not.toContain(
          (process.env.PRODUCT_UPLOAD_DIR ?? '').toLowerCase(),
        );
      }
    });
  });
});

import { INestApplication } from '@nestjs/common';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditService } from '../src/audit/audit.service';
import { PURCHASE_DOCUMENT_STORAGE } from '../src/purchase-invoices/attachments/storage/purchase-document-storage.interface';
import type { PurchaseDocumentStorage } from '../src/purchase-invoices/attachments/storage/purchase-document-storage.interface';
import { makeJpeg, makePdf, makePng } from './helpers/document-fixtures';
import { login } from './helpers/http';
import { createR5Context, IdBody, R5Context } from './helpers/r5-fixtures';

interface AttachmentBody extends IdBody {
  purchaseInvoiceId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  status: string;
  canDelete: boolean;
  previewable: boolean;
  idempotentReplay: boolean;
  storageKey?: string;
}

/**
 * R5 — documentos adjuntos de facturas de compra. HTTP real y PostgreSQL real.
 * Todo el flujo usa un usuario cuyo ÚNICO rol activo es PURCHASING; los archivos
 * viven en un directorio temporal aislado por suite.
 */
describe('R5 — documentos adjuntos de facturas de compra (e2e)', () => {
  let ctx: R5Context;
  let app: INestApplication<App>;

  const filesOnDisk = (dir: string = ctx.docsDir): number =>
    readdirSync(dir).reduce((total, entry) => {
      const full = join(dir, entry);
      return total + (statSync(full).isDirectory() ? filesOnDisk(full) : 1);
    }, 0);

  function upload(
    invoiceId: string,
    buffer: Buffer,
    filename: string,
    contentType: string,
    opts: { cookie?: string; key?: string } = {},
  ): Promise<request.Response> {
    const req = request(app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${invoiceId}/attachments`)
      .set('Cookie', opts.cookie ?? ctx.purchasingCookie);
    if (opts.key !== undefined) {
      req.set('Idempotency-Key', opts.key);
    }
    return req.attach('file', buffer, { filename, contentType });
  }
  const bytes = (res: request.Response): Buffer => res.body as Buffer;
  function fetchBinary(
    path: string,
    cookie: string = ctx.purchasingCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Cookie', cookie)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
  }

  async function draftInvoice(): Promise<string> {
    return (await ctx.createInvoice(await ctx.newSupplier())).id;
  }

  beforeAll(async () => {
    ctx = await createR5Context('att');
    app = ctx.app;
  }, 180000);

  afterAll(async () => {
    await ctx.dispose();
  });

  it('A1. PDF, JPG y PNG válidos: se guardan, se listan, previsualizan y descargan con los bytes originales; persisten en una nueva sesión', async () => {
    const invoiceId = await draftInvoice();
    const files = [
      { name: 'Factura 01.pdf', buf: makePdf(), mime: 'application/pdf' },
      { name: 'foto.JPG', buf: makeJpeg(), mime: 'image/jpeg' },
      { name: 'sello.png', buf: makePng(), mime: 'image/png' },
    ];
    const created: AttachmentBody[] = [];
    for (const f of files) {
      const res = await upload(invoiceId, f.buf, f.name, f.mime);
      created.push(ctx.ok<AttachmentBody>(res, 201, `subir ${f.name}`));
    }
    created.forEach((c, i) => {
      expect(c).toMatchObject({
        purchaseInvoiceId: invoiceId,
        fileName: files[i].name,
        mimeType: files[i].mime,
        fileSize: files[i].buf.length,
        status: 'ACTIVE',
        canDelete: true,
        previewable: true,
        idempotentReplay: false,
      });
      // nunca se expone la clave/ruta de almacenamiento
      expect(JSON.stringify(c)).not.toMatch(/storage|uploads/i);
      expect(c.storageKey).toBeUndefined();
    });
    expect(filesOnDisk()).toBeGreaterThanOrEqual(3);

    // Nueva sesión del mismo usuario (otro login/cookie)
    const second = await login(
      app.getHttpServer(),
      (
        await ctx.prisma.user.findUniqueOrThrow({
          where: { id: ctx.purchasingUserId },
          select: { username: true },
        })
      ).username,
      'R5Fixture2026Password',
    );
    expect(second.status).toBe(200);
    const list = ctx.ok<AttachmentBody[]>(
      await ctx.api(
        'get',
        `/purchase-invoices/${invoiceId}/attachments`,
        second.cookie,
      ),
      200,
      'listar',
    );
    expect(list.map((a) => a.id)).toEqual(created.map((c) => c.id));

    for (const [i, c] of created.entries()) {
      const preview = await fetchBinary(
        `/purchase-invoices/${invoiceId}/attachments/${c.id}/preview`,
        second.cookie,
      );
      expect(preview.status).toBe(200);
      expect(bytes(preview).equals(files[i].buf)).toBe(true);
      expect(preview.headers['content-type']).toContain(files[i].mime);
      expect(preview.headers['content-disposition']).toMatch(/^inline;/);
      expect(preview.headers['x-content-type-options']).toBe('nosniff');
      expect(preview.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
      expect(preview.headers['cache-control']).toContain('no-store');

      const download = await fetchBinary(
        `/purchase-invoices/${invoiceId}/attachments/${c.id}/download`,
        second.cookie,
      );
      expect(download.status).toBe(200);
      expect(bytes(download).equals(files[i].buf)).toBe(true);
      expect(download.headers['content-disposition']).toMatch(/^attachment;/);
      expect(download.headers['content-disposition']).toContain(
        encodeURIComponent(files[i].name),
      );
    }
  });

  it('A2. rechaza extensión falsa, tipo declarado falso, contenido corrupto, no soportado, vacío y > 10 MB', async () => {
    const invoiceId = await draftInvoice();
    const before = filesOnDisk();
    const code = (res: request.Response): string | undefined =>
      ctx.err(res).code;

    // PNG real con nombre .pdf (extensión falsa)
    let res = await upload(invoiceId, makePng(), 'engano.pdf', 'image/png');
    expect(res.status).toBe(400);
    expect(code(res)).toBe('ATTACHMENT_EXTENSION_MISMATCH');
    expect(ctx.err(res).errors?.[0]).toMatchObject({ field: 'file' });

    // Content-Type declarado distinto del contenido real
    res = await upload(invoiceId, makePng(), 'a.png', 'application/pdf');
    expect(res.status).toBe(400);
    expect(code(res)).toBe('ATTACHMENT_MIME_MISMATCH');

    // Ejecutable disfrazado de PDF
    res = await upload(
      invoiceId,
      Buffer.from('MZ\u0090\u0000ejecutable'),
      'virus.pdf',
      'application/pdf',
    );
    expect(res.status).toBe(400);
    expect(code(res)).toBe('ATTACHMENT_UNSUPPORTED_TYPE');

    // Truncado / corrupto
    res = await upload(
      invoiceId,
      makePng().subarray(0, 30),
      'rota.png',
      'image/png',
    );
    expect(res.status).toBe(400);
    expect(code(res)).toBe('ATTACHMENT_CORRUPT');

    // PDF con JavaScript embebido
    res = await upload(
      invoiceId,
      makePdf('/JavaScript (app.alert(1)) '),
      'js.pdf',
      'application/pdf',
    );
    expect(res.status).toBe(400);
    expect(code(res)).toBe('ATTACHMENT_ACTIVE_CONTENT');

    // Vacío
    res = await upload(invoiceId, Buffer.alloc(0), 'v.pdf', 'application/pdf');
    expect(res.status).toBe(400);

    // Mayor a 10 MB (PDF válido más relleno): 413 desde la capa multipart
    const big = makePdf('', 10 * 1024 * 1024);
    res = await upload(invoiceId, big, 'grande.pdf', 'application/pdf');
    expect(res.status).toBe(413);

    // Exactamente en el límite sigue siendo válido
    const target = 10 * 1024 * 1024;
    const padded = makePdf('', target - makePdf('', 0).length);
    expect(padded.length).toBe(target);
    res = await upload(invoiceId, padded, 'limite.pdf', 'application/pdf');
    expect(res.status).toBe(201);

    // Ningún rechazo dejó archivos físicos ni filas
    expect(filesOnDisk()).toBe(before + 1);
    expect(
      await ctx.prisma.purchaseInvoiceAttachment.count({
        where: { purchaseInvoiceId: invoiceId },
      }),
    ).toBe(1);
  }, 60000);

  it('A3. autorización: sin sesión 401; SELLER/WAREHOUSE 403; MANAGEMENT/ACCOUNTANT leen pero no escriben', async () => {
    const invoiceId = await draftInvoice();
    const att = ctx.ok<AttachmentBody>(
      await upload(invoiceId, makePdf(), 'a.pdf', 'application/pdf'),
      201,
      'subir',
    );
    const base = `/purchase-invoices/${invoiceId}/attachments`;

    const anon = await request(app.getHttpServer()).get(`/api/v1${base}`);
    expect(anon.status).toBe(401);
    const anonFile = await request(app.getHttpServer()).get(
      `/api/v1${base}/${att.id}/download`,
    );
    expect(anonFile.status).toBe(401);

    for (const cookie of [ctx.sellerCookie, ctx.warehouseCookie]) {
      expect((await ctx.api('get', base, cookie)).status).toBe(403);
      expect(
        (await ctx.api('get', `${base}/${att.id}/download`, cookie)).status,
      ).toBe(403);
      expect(
        (
          await upload(invoiceId, makePdf('', 2), 'x.pdf', 'application/pdf', {
            cookie,
          })
        ).status,
      ).toBe(403);
      expect(
        (await ctx.api('delete', `${base}/${att.id}`, cookie)).status,
      ).toBe(403);
    }
    for (const cookie of [ctx.managementCookie, ctx.accountantCookie]) {
      expect((await ctx.api('get', base, cookie)).status).toBe(200);
      const dl = await fetchBinary(`${base}/${att.id}/download`, cookie);
      expect(dl.status).toBe(200);
      expect(
        (
          await upload(invoiceId, makePdf('', 3), 'x.pdf', 'application/pdf', {
            cookie,
          })
        ).status,
      ).toBe(403);
      expect(
        (await ctx.api('delete', `${base}/${att.id}`, cookie)).status,
      ).toBe(403);
    }
    // Nada cambió
    expect(
      await ctx.prisma.purchaseInvoiceAttachment.count({
        where: { purchaseInvoiceId: invoiceId, status: 'ACTIVE' },
      }),
    ).toBe(1);
  });

  it('A4. sin IDOR: un id de adjunto no sirve bajo otra factura, ni inexistente, ni por ruta directa del archivo', async () => {
    const supplierId = await ctx.newSupplier();
    const invoiceA = (await ctx.createInvoice(supplierId)).id;
    const invoiceB = (await ctx.createInvoice(supplierId)).id;
    const att = ctx.ok<AttachmentBody>(
      await upload(invoiceA, makePdf(), 'a.pdf', 'application/pdf'),
      201,
      'subir',
    );
    const stored = await ctx.prisma.purchaseInvoiceAttachment.findUniqueOrThrow(
      {
        where: { id: att.id },
      },
    );

    const wrongInvoice = await ctx.asP(
      'get',
      `/purchase-invoices/${invoiceB}/attachments/${att.id}/download`,
    );
    expect(wrongInvoice.status).toBe(404);
    const missing = await ctx.asP(
      'get',
      `/purchase-invoices/${invoiceA}/attachments/00000000-0000-4000-8000-000000000000/download`,
    );
    expect(missing.status).toBe(404);
    // Mismo cuerpo de error (no revela existencia)
    expect(ctx.err(wrongInvoice).code).toBe(ctx.err(missing).code);

    // La clave de almacenamiento no es accesible como ruta estática
    for (const path of [
      `/${stored.storageKey}`,
      `/uploads/purchase-documents/${stored.storageKey}`,
      `/api/v1/uploads/${stored.storageKey}`,
      `/api/v1/purchase-invoices/${invoiceA}/attachments/${stored.storageKey}`,
    ]) {
      const res = await request(app.getHttpServer())
        .get(path)
        .set('Cookie', ctx.adminCookie);
      expect([400, 404]).toContain(res.status);
    }
    // El nombre físico es aleatorio, no deriva del nombre original
    expect(stored.storageKey).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{64}\.pdf$/);
    expect(stored.storageKey).not.toContain('a.pdf');
  });

  it('A5. DRAFT: se pueden eliminar; el borrado es lógico, el archivo físico se retira y se audita', async () => {
    const invoiceId = await draftInvoice();
    const keep = ctx.ok<AttachmentBody>(
      await upload(invoiceId, makePdf(), 'a.pdf', 'application/pdf'),
      201,
      'subir A',
    );
    const drop = ctx.ok<AttachmentBody>(
      await upload(invoiceId, makeJpeg(), 'b.jpg', 'image/jpeg'),
      201,
      'subir B',
    );
    const dropRow =
      await ctx.prisma.purchaseInvoiceAttachment.findUniqueOrThrow({
        where: { id: drop.id },
      });
    const before = filesOnDisk();

    const del = await ctx.asP(
      'delete',
      `/purchase-invoices/${invoiceId}/attachments/${drop.id}`,
    );
    expect(del.status).toBe(204);
    expect(filesOnDisk()).toBe(before - 1);

    const list = ctx.ok<AttachmentBody[]>(
      await ctx.asP('get', `/purchase-invoices/${invoiceId}/attachments`),
      200,
      'listar',
    );
    expect(list.map((a) => a.id)).toEqual([keep.id]);
    expect(
      (
        await fetchBinary(
          `/purchase-invoices/${invoiceId}/attachments/${drop.id}/download`,
        )
      ).status,
    ).toBe(404);
    // Segundo borrado: 404 (ya eliminado)
    expect(
      (
        await ctx.asP(
          'delete',
          `/purchase-invoices/${invoiceId}/attachments/${drop.id}`,
        )
      ).status,
    ).toBe(404);

    const row = await ctx.prisma.purchaseInvoiceAttachment.findUniqueOrThrow({
      where: { id: drop.id },
    });
    expect(row.status).toBe('DELETED');
    expect(row.deletedByUserId).toBe(ctx.purchasingUserId);
    expect(row.storageKey).toBe(dropRow.storageKey);

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: {
        action: 'PURCHASE_INVOICE_ATTACHMENT_DELETED',
        entityId: invoiceId,
      },
    });
    expect(audit.userId).toBe(ctx.purchasingUserId);
    expect(JSON.stringify(audit.metadata)).toContain(drop.id);
    expect(JSON.stringify(audit.metadata)).not.toContain('b.jpg');
  });

  it('A6. CONFIRMED: se conservan los documentos, se pueden agregar complementarios (auditado) y NO se pueden eliminar; la factura no cambia', async () => {
    const invoice = await ctx.createInvoice(await ctx.newSupplier());
    const first = ctx.ok<AttachmentBody>(
      await upload(invoice.id, makePdf(), 'original.pdf', 'application/pdf'),
      201,
      'subir',
    );
    await ctx.confirm(invoice.id);
    const invoiceBefore = ctx.ok<Record<string, unknown>>(
      await ctx.asP('get', `/purchase-invoices/${invoice.id}`),
      200,
      'factura antes',
    );

    const extra = ctx.ok<AttachmentBody>(
      await upload(invoice.id, makePng(), 'complemento.png', 'image/png'),
      201,
      'subir complemento',
    );
    expect(extra.canDelete).toBe(false);

    const invoiceAfter = ctx.ok<Record<string, unknown>>(
      await ctx.asP('get', `/purchase-invoices/${invoice.id}`),
      200,
      'factura después',
    );
    // Adjuntar no cambia estado, importes ni contabilización
    expect(invoiceAfter).toEqual(invoiceBefore);
    expect(invoiceAfter.status).toBe('CONFIRMED');

    for (const id of [first.id, extra.id]) {
      const res = await ctx.asP(
        'delete',
        `/purchase-invoices/${invoice.id}/attachments/${id}`,
      );
      expect(res.status).toBe(409);
      expect(ctx.err(res).code).toBe('ATTACHMENT_DELETE_NOT_ALLOWED');
    }
    const list = ctx.ok<AttachmentBody[]>(
      await ctx.asP('get', `/purchase-invoices/${invoice.id}/attachments`),
      200,
      'listar',
    );
    expect(list).toHaveLength(2);
    expect(list.every((a) => a.canDelete === false)).toBe(true);

    const audit = await ctx.prisma.auditLog.count({
      where: {
        action: 'PURCHASE_INVOICE_ATTACHMENT_UPLOADED',
        entityId: invoice.id,
        userId: ctx.purchasingUserId,
      },
    });
    expect(audit).toBe(2);

    // Anulada: ya no admite documentos nuevos (los existentes se conservan)
    ctx.ok(
      await ctx.asP('post', `/purchase-invoices/${invoice.id}/cancel`, {
        reason: 'prueba R5',
      }),
      200,
      'anular',
    );
    const afterCancel = await upload(
      invoice.id,
      makePdf('', 5),
      'tarde.pdf',
      'application/pdf',
    );
    expect(afterCancel.status).toBe(409);
    expect(ctx.err(afterCancel).code).toBe('PURCHASE_INVOICE_CANCELLED');
  });

  it('A7. idempotencia: misma clave y contenido devuelve la carga original sin duplicar; contenido distinto es 409; concurrente crea una sola', async () => {
    const invoiceId = await draftInvoice();
    const buf = makePdf('', 7);
    const first = ctx.ok<AttachmentBody>(
      await upload(invoiceId, buf, 'a.pdf', 'application/pdf', { key: 'k-1' }),
      201,
      'primera',
    );
    expect(first.idempotentReplay).toBe(false);
    const filesAfterFirst = filesOnDisk();
    const replay = ctx.ok<AttachmentBody>(
      await upload(invoiceId, buf, 'a.pdf', 'application/pdf', { key: 'k-1' }),
      201,
      'reintento',
    );
    expect(replay.id).toBe(first.id);
    expect(replay.idempotentReplay).toBe(true);
    expect(filesOnDisk()).toBe(filesAfterFirst);

    const different = await upload(
      invoiceId,
      makePdf('', 8),
      'otro.pdf',
      'application/pdf',
      { key: 'k-1' },
    );
    expect(different.status).toBe(409);
    expect(ctx.err(different).code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    const bad = await upload(invoiceId, buf, 'a.pdf', 'application/pdf', {
      key: 'clave con espacios!',
    });
    expect(bad.status).toBe(400);

    // Dos solicitudes simultáneas con la misma clave
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        upload(invoiceId, makePdf('', 9), 'c.pdf', 'application/pdf', {
          key: 'k-race',
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    const ids = new Set(results.map((r) => (r.body as AttachmentBody).id));
    expect(ids.size).toBe(1);
    expect(
      await ctx.prisma.purchaseInvoiceAttachment.count({
        where: { purchaseInvoiceId: invoiceId, idempotencyKey: 'k-race' },
      }),
    ).toBe(1);
    // Sin archivos huérfanos: 1 de k-1 + 1 de k-race
    expect(filesOnDisk()).toBe(filesAfterFirst + 1);
  });

  it('A8. fallos: si el almacenamiento falla la factura queda íntegra; si falla el registro se retira el archivo (sin huérfanos ni filas colgantes)', async () => {
    const invoice = await ctx.createInvoice(await ctx.newSupplier());
    const invoiceBefore = ctx.ok<Record<string, unknown>>(
      await ctx.asP('get', `/purchase-invoices/${invoice.id}`),
      200,
      'factura',
    );
    const storage = app.get<PurchaseDocumentStorage>(PURCHASE_DOCUMENT_STORAGE);
    const audit = app.get(AuditService);

    // (1) Falla el almacenamiento
    const saveSpy = jest
      .spyOn(storage, 'save')
      .mockRejectedValueOnce(new Error('disco lleno (simulado)'));
    const filesBefore = filesOnDisk();
    const failedStorage = await upload(
      invoice.id,
      makePdf('', 11),
      'a.pdf',
      'application/pdf',
    );
    saveSpy.mockRestore();
    expect(failedStorage.status).toBe(500);
    expect(JSON.stringify(failedStorage.body)).not.toMatch(/disco lleno/);
    expect(filesOnDisk()).toBe(filesBefore);
    expect(
      await ctx.prisma.purchaseInvoiceAttachment.count({
        where: { purchaseInvoiceId: invoice.id },
      }),
    ).toBe(0);

    // (2) Falla el registro (auditoría dentro de la transacción) tras guardar el archivo
    const auditSpy = jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('fallo de registro (simulado)'));
    const failedRecord = await upload(
      invoice.id,
      makePdf('', 12),
      'b.pdf',
      'application/pdf',
    );
    auditSpy.mockRestore();
    expect(failedRecord.status).toBe(500);
    expect(filesOnDisk()).toBe(filesBefore); // el archivo se retiró (compensación)
    expect(
      await ctx.prisma.purchaseInvoiceAttachment.count({
        where: { purchaseInvoiceId: invoice.id },
      }),
    ).toBe(0);

    // La factura quedó íntegra y el reintento funciona
    expect(
      ctx.ok<Record<string, unknown>>(
        await ctx.asP('get', `/purchase-invoices/${invoice.id}`),
        200,
        'factura final',
      ),
    ).toEqual(invoiceBefore);
    ctx.ok(
      await upload(invoice.id, makePdf('', 12), 'b.pdf', 'application/pdf'),
      201,
      'reintento',
    );
    expect(filesOnDisk()).toBe(filesBefore + 1);

    // Archivo físico ausente (integridad): 404 controlado, sin detalles internos
    const row = await ctx.prisma.purchaseInvoiceAttachment.findFirstOrThrow({
      where: { purchaseInvoiceId: invoice.id },
    });
    await storage.delete(row.storageKey);
    const missingFile = await fetchBinary(
      `/purchase-invoices/${invoice.id}/attachments/${row.id}/download`,
    );
    expect(missingFile.status).toBe(404);
  });

  it('A9. Importaciones consulta los MISMOS documentos de la factura vinculada, sin copias físicas y con los permisos de la compra', async () => {
    const invoice = await ctx.createInvoice(await ctx.newSupplier());
    const att = ctx.ok<AttachmentBody>(
      await upload(invoice.id, makePdf(), 'compra.pdf', 'application/pdf'),
      201,
      'subir',
    );
    await ctx.confirm(invoice.id);
    const op = await ctx.newOperation(invoice.id);
    const filesBefore = filesOnDisk();

    const listing = ctx.ok<{
      importOperationId: string;
      purchaseInvoiceId: string | null;
      documents: AttachmentBody[];
    }>(
      await ctx.asP('get', `/import-operations/${op.id}/documents`),
      200,
      'documentos de la importación',
    );
    expect(listing.purchaseInvoiceId).toBe(invoice.id);
    expect(listing.documents.map((d) => d.id)).toEqual([att.id]);

    const viaImport = await fetchBinary(
      `/import-operations/${op.id}/documents/${att.id}/download`,
    );
    const viaInvoice = await fetchBinary(
      `/purchase-invoices/${invoice.id}/attachments/${att.id}/download`,
    );
    expect(viaImport.status).toBe(200);
    expect(bytes(viaImport).equals(bytes(viaInvoice))).toBe(true);
    expect(
      (
        await fetchBinary(
          `/import-operations/${op.id}/documents/${att.id}/preview`,
        )
      ).status,
    ).toBe(200);
    expect(filesOnDisk()).toBe(filesBefore); // ninguna copia por importación
    expect(
      await ctx.prisma.purchaseInvoiceAttachment.count({
        where: { purchaseInvoiceId: invoice.id },
      }),
    ).toBe(1);

    // Roles de lectura de la compra; WAREHOUSE y SELLER no
    for (const cookie of [
      ctx.adminCookie,
      ctx.managementCookie,
      ctx.accountantCookie,
    ]) {
      expect(
        (await ctx.api('get', `/import-operations/${op.id}/documents`, cookie))
          .status,
      ).toBe(200);
    }
    for (const cookie of [ctx.warehouseCookie, ctx.sellerCookie]) {
      expect(
        (await ctx.api('get', `/import-operations/${op.id}/documents`, cookie))
          .status,
      ).toBe(403);
    }
    // Un adjunto de otra factura no se sirve bajo esta operación
    const other = await ctx.createInvoice(await ctx.newSupplier());
    const otherAtt = ctx.ok<AttachmentBody>(
      await upload(other.id, makePdf('', 20), 'ajeno.pdf', 'application/pdf'),
      201,
      'subir ajeno',
    );
    expect(
      (
        await fetchBinary(
          `/import-operations/${op.id}/documents/${otherAtt.id}/download`,
        )
      ).status,
    ).toBe(404);

    // Operación histórica sin factura: vacío, sin error
    const legacy = await ctx.prisma.importOperation.create({
      data: {
        reference: `LEG-R5-${ctx.nextSuffix()}`,
        originCountry: 'CN',
        destinationCountry: 'PE',
        isLegacyUnlinked: true,
        createdByUserId: ctx.purchasingUserId,
      },
    });
    const legacyList = ctx.ok<{
      purchaseInvoiceId: string | null;
      documents: unknown[];
    }>(
      await ctx.asP('get', `/import-operations/${legacy.id}/documents`),
      200,
      'histórica',
    );
    expect(legacyList).toMatchObject({
      purchaseInvoiceId: null,
      documents: [],
    });
    await ctx.prisma.importOperation.delete({ where: { id: legacy.id } });
  });

  it('A10. la auditoría de carga registra al usuario real y no guarda el nombre del archivo ni su contenido', async () => {
    const invoiceId = await draftInvoice();
    const att = ctx.ok<AttachmentBody>(
      await upload(
        invoiceId,
        makePdf('', 30),
        'Secreto-Cliente.pdf',
        'application/pdf',
      ),
      201,
      'subir',
    );
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: {
        action: 'PURCHASE_INVOICE_ATTACHMENT_UPLOADED',
        entityId: invoiceId,
      },
    });
    expect(audit.userId).toBe(ctx.purchasingUserId);
    const meta = JSON.stringify(audit.metadata);
    expect(meta).toContain(att.id);
    expect(meta).toContain('application/pdf');
    expect(meta).not.toMatch(/Secreto|%PDF/);
  });
});

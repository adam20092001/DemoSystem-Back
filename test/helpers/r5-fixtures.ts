import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSystemKey,
  InventoryValuationMethod,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  PurchaseInvoiceDocumentType,
  RoleName,
  SupplierDocumentType,
} from '@prisma/client';
import { mkdirSync, rmSync } from 'node:fs';
import request from 'supertest';
import { App } from 'supertest/types';
import { businessToday } from '../../src/common/date/business-date';
import { E2E_ADMIN_ACTIVE_PASSWORD, E2E_ADMIN_USERNAME } from './constants';
import { createE2eApp } from './e2e-app';
import { upsertFixtureUser } from './fixtures';
import { login } from './http';
import { createTestPrismaClient } from './prisma-test-client';
import { purgePurchasingResidue } from './purchasing-cleanup';
import { createProductRow } from './stock-fixtures';

export type Method = 'get' | 'post' | 'patch' | 'delete';
export interface IdBody {
  id: string;
}
export interface ErrBody {
  statusCode: number;
  message: string | string[];
  kind?: 'FORM' | 'GENERAL';
  code?: string;
  errors?: { field: string; code: string; type: string; message: string }[];
}
export interface InvoiceBody extends IdBody {
  status: string;
  lines: { id: string; quantity: string }[];
}
export interface OperationBody extends IdBody {
  reference: string;
  status: string;
}
export interface ShipmentBody extends IdBody {
  status: string;
  lines: { id: string }[];
}

const PASSWORD = 'R5Fixture2026Password';

/**
 * Entorno E2E común de R5 (adjuntos y recepción desde Importaciones): usuarios
 * por rol (incl. un usuario cuyo ÚNICO rol activo es PURCHASING), productos,
 * IGV como fixture, mapeos contables sintéticos y un directorio TEMPORAL AISLADO
 * para los documentos. Todo se retira en dispose().
 */
export interface R5Context {
  app: INestApplication<App>;
  prisma: PrismaClient;
  docsDir: string;
  adminCookie: string;
  purchasingCookie: string;
  purchasingUserId: string;
  warehouseCookie: string;
  sellerCookie: string;
  managementCookie: string;
  accountantCookie: string;
  productId: string;
  valuedProductId: string;
  supplierPrefix: string;
  api: (
    method: Method,
    path: string,
    cookie: string,
    body?: Record<string, unknown>,
  ) => Promise<request.Response>;
  asP: (
    method: Method,
    path: string,
    body?: Record<string, unknown>,
  ) => Promise<request.Response>;
  ok: <T>(res: request.Response, status: number, label: string) => T;
  err: (res: request.Response) => ErrBody;
  nextSuffix: () => string;
  newSupplier: () => Promise<string>;
  createInvoice: (
    supplierId: string,
    over?: Record<string, unknown>,
    line?: Record<string, unknown>,
  ) => Promise<InvoiceBody>;
  confirm: (invoiceId: string) => Promise<InvoiceBody>;
  newOperation: (invoiceId: string) => Promise<OperationBody>;
  createShipment: (
    operationId: string,
    lines: { invoiceLineId: string; quantity: string }[],
  ) => Promise<ShipmentBody>;
  arriveShipment: (shipmentId: string) => Promise<void>;
  newLocation: () => Promise<string>;
  /** Producto inventariable nuevo (stock 0): cada escenario usa el suyo para aislar el stock. */
  newProduct: (valued: boolean) => Promise<string>;
  dispose: () => Promise<void>;
}

export async function createR5Context(tag: string): Promise<R5Context> {
  // Aislada por archivo de prueba (jest-e2e.setup.ts); se crea para poder
  // contar archivos desde el inicio y se retira en dispose().
  const docsDir = process.env.PURCHASE_DOCUMENTS_DIR as string;
  mkdirSync(docsDir, { recursive: true });

  const prisma = createTestPrismaClient();
  const app = await createE2eApp();
  const RUN_ID = Date.now();
  let counter = 0;
  const nextSuffix = (): string => {
    counter += 1;
    return `${RUN_ID}${counter}`;
  };
  const supplierPrefix = `Proveedor e2e R5${tag}`;
  const accountPrefix = `R5${tag.toUpperCase()}`;

  const api: R5Context['api'] = (method, path, cookie, body) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Cookie', cookie);
    return body === undefined ? req : req.send(body);
  };

  const ok: R5Context['ok'] = <T>(
    res: request.Response,
    status: number,
    label: string,
  ): T => {
    if (res.status !== status) {
      throw new Error(
        `${label}: esperado ${status}, recibido ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    return res.body as T;
  };

  const adminLogin = await login(
    app.getHttpServer(),
    E2E_ADMIN_USERNAME,
    E2E_ADMIN_ACTIVE_PASSWORD,
  );
  if (adminLogin.status !== 200) {
    throw new Error('login admin');
  }
  const adminCookie = adminLogin.cookie;

  const suffix = nextSuffix();
  const mk = async (
    role: RoleName,
    name: string,
  ): Promise<{ cookie: string; id: string }> => {
    const username = `e2e_r5${tag}_${name}_${suffix}`.slice(0, 50);
    const user = await upsertFixtureUser(prisma, {
      username,
      email: `${username}@demosystem.test`,
      password: PASSWORD,
      roleName: role,
    });
    const res = await login(app.getHttpServer(), username, PASSWORD);
    if (res.status !== 200) {
      throw new Error(`login ${name}`);
    }
    return { cookie: res.cookie, id: user.id };
  };
  const purchasing = await mk(RoleName.PURCHASING, 'purch');
  const warehouse = await mk(RoleName.WAREHOUSE, 'wh');
  const seller = await mk(RoleName.SELLER, 'sell');
  const management = await mk(RoleName.MANAGEMENT, 'mgmt');
  const accountant = await mk(RoleName.ACCOUNTANT, 'acc');

  const asP: R5Context['asP'] = (method, path, body) =>
    api(method, path, purchasing.cookie, body);

  const categoryId = (
    await prisma.category.findFirstOrThrow({ where: { code: 'SERVICIOS' } })
  ).id;
  const unitId = (
    await prisma.unit.findFirstOrThrow({ where: { code: 'SER' } })
  ).id;
  const mkProduct = async (valued: boolean): Promise<string> => {
    const row = await createProductRow(prisma, {
      data: {
        sku: `R5${tag}-${valued ? 'V' : 'N'}-${nextSuffix()}`,
        name: `Producto e2e R5${tag} ${nextSuffix()}`,
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: new Prisma.Decimal('900.00'),
        isInventoryTracked: true,
        stockCurrent: new Prisma.Decimal('0.000'),
        status: ProductStatus.ACTIVE,
        valuationMethod: valued
          ? InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE
          : null,
      },
      select: { id: true },
    });
    return row.id;
  };
  const productId = await mkProduct(false);
  const valuedProductId = await mkProduct(true);

  const settings = await prisma.companySettings.findFirstOrThrow();
  const originalTax = {
    taxEnabled: settings.taxEnabled,
    taxRate: settings.taxRate,
  };
  await prisma.companySettings.updateMany({
    data: { taxEnabled: true, taxRate: new Prisma.Decimal('18.00') },
  });

  const createAccount = async (
    code: string,
    type: AccountType,
  ): Promise<string> => {
    const res = await api('post', '/chart-of-accounts', adminCookie, {
      code,
      name: `Cuenta e2e R5 ${code}`,
      type,
      isPostable: true,
    });
    return ok<IdBody>(res, 201, `cuenta ${code}`).id;
  };
  const mapKey = async (
    key: AccountingSystemKey,
    accountId: string,
  ): Promise<void> => {
    ok(
      await api('patch', `/chart-of-accounts/system-keys/${key}`, adminCookie, {
        accountId,
      }),
      200,
      `mapeo ${key}`,
    );
  };
  const short = Date.now() % 1000000;
  await mapKey(
    AccountingSystemKey.ACCOUNTS_PAYABLE,
    await createAccount(`${accountPrefix}AP${short}`, AccountType.LIABILITY),
  );
  await mapKey(
    AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
    await createAccount(`${accountPrefix}RS${short}`, AccountType.ASSET),
  );
  await mapKey(
    AccountingSystemKey.VAT_RECEIVABLE,
    await createAccount(`${accountPrefix}VT${short}`, AccountType.ASSET),
  );

  const newSupplier = async (): Promise<string> => {
    const s = nextSuffix();
    return ok<IdBody>(
      await asP('post', '/suppliers', {
        documentType: SupplierDocumentType.RUC,
        documentNumber: s.slice(-11).padStart(11, '0'),
        legalName: `${supplierPrefix} ${s}`,
      }),
      201,
      'proveedor',
    ).id;
  };

  const createInvoice: R5Context['createInvoice'] = async (
    supplierId,
    over = {},
    line = {},
  ) => {
    const s = nextSuffix();
    return ok<InvoiceBody>(
      await asP('post', '/purchase-invoices', {
        supplierId,
        documentType: PurchaseInvoiceDocumentType.FACTURA,
        documentSeries: 'F905',
        documentNumber: s.slice(-8),
        issueDate: businessToday(),
        lines: [
          {
            productId,
            acquisitionKind: 'GOOD',
            purchasePurpose: 'RESALE_INVENTORY',
            quantity: '10.000',
            unitCost: '100.00',
            taxCategory: 'UNAFFECTED',
            ...line,
          },
        ],
        ...over,
      }),
      201,
      'crear factura',
    );
  };
  const confirm: R5Context['confirm'] = async (invoiceId) =>
    ok<InvoiceBody>(
      await asP('post', `/purchase-invoices/${invoiceId}/confirm`, {}),
      200,
      'confirmar factura',
    );
  const newOperation: R5Context['newOperation'] = async (invoiceId) =>
    ok<OperationBody>(
      await asP('post', '/import-operations', {
        purchaseInvoiceId: invoiceId,
        originCountry: 'CN',
        destinationCountry: 'PE',
      }),
      201,
      'crear operación',
    );
  const createShipment: R5Context['createShipment'] = async (
    operationId,
    lines,
  ) =>
    ok<ShipmentBody>(
      await asP('post', `/import-operations/${operationId}/shipments`, {
        transportMode: 'SEA',
        incoterm: 'FOB',
        incotermNamedPlace: 'Shanghai',
        lines: lines.map((l) => ({
          descriptionSnapshot: 'Carga',
          plannedQuantity: l.quantity,
          purchaseInvoiceLineId: l.invoiceLineId,
        })),
      }),
      201,
      'crear embarque',
    );
  const arriveShipment: R5Context['arriveShipment'] = async (shipmentId) => {
    ok(
      await asP('post', `/import-shipments/${shipmentId}/depart`, {}),
      200,
      'depart',
    );
    ok(
      await asP('post', `/import-shipments/${shipmentId}/arrive`, {}),
      200,
      'arrive',
    );
  };

  const warehouseIds: string[] = [];
  const newLocation: R5Context['newLocation'] = async () => {
    const code = `R5${nextSuffix()}`.slice(-18);
    const wh = ok<IdBody>(
      await api('post', '/warehouses', adminCookie, {
        code,
        name: `Almacén R5 ${code}`,
      }),
      201,
      'almacén',
    );
    warehouseIds.push(wh.id);
    return ok<IdBody>(
      await api('post', `/warehouses/${wh.id}/locations`, adminCookie, {
        code: `L${code}`.slice(0, 20),
        name: `Ubicación R5 ${code}`,
      }),
      201,
      'ubicación',
    ).id;
  };

  const dispose = async (): Promise<void> => {
    try {
      await purgePurchasingResidue(prisma, {
        supplierLegalNamePrefix: supplierPrefix,
        accountCodePrefixes: [accountPrefix],
        importOperationReferencePrefixes: ['R5LEG-'],
      });
      await prisma.companySettings.updateMany({ data: originalTax });
      await prisma.account.updateMany({
        where: {
          systemKey: {
            in: [
              AccountingSystemKey.ACCOUNTS_PAYABLE,
              AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
              AccountingSystemKey.VAT_RECEIVABLE,
            ],
          },
        },
        data: { systemKey: null },
      });
    } finally {
      await prisma.$disconnect();
      await app.close();
      rmSync(docsDir, { recursive: true, force: true });
    }
  };

  return {
    app,
    prisma,
    docsDir,
    adminCookie,
    purchasingCookie: purchasing.cookie,
    purchasingUserId: purchasing.id,
    warehouseCookie: warehouse.cookie,
    sellerCookie: seller.cookie,
    managementCookie: management.cookie,
    accountantCookie: accountant.cookie,
    productId,
    valuedProductId,
    supplierPrefix,
    api,
    asP,
    ok,
    err: (res) => res.body as ErrBody,
    nextSuffix,
    newSupplier,
    createInvoice,
    confirm,
    newOperation,
    createShipment,
    arriveShipment,
    newLocation,
    newProduct: mkProduct,
    dispose,
  };
}

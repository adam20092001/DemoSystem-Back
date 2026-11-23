import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { PaymentMethodsController } from '../payment-methods/payment-methods.controller';
import { ImportExpensesController } from '../import-operations/import-expenses.controller';
import { ImportOperationsController } from '../import-operations/import-operations.controller';
import { ImportOperationsService } from '../import-operations/import-operations.service';
import {
  ImportExpenseAllocationCostPreviewController,
  ImportReceiptLinksController,
  ImportShipmentLineReceiptLinksController,
} from '../import-operations/import-receipt-links.controller';
import { ImportReportsController } from '../import-operations/import-reports.controller';
import { ImportShipmentsController } from '../import-operations/import-shipments.controller';
import { PurchaseInvoicesController } from '../purchase-invoices/purchase-invoices.controller';
import {
  PurchaseInvoiceReceiptsController,
  PurchaseReceiptsController,
} from '../purchase-receipts/purchase-receipts.controller';
import { PurchaseReceivingController } from '../purchase-receipts/purchase-receiving.controller';
import { SuppliersController } from '../suppliers/suppliers.controller';
import { AccountsPayableController } from '../supplier-payments/accounts-payable.controller';
import { SupplierPaymentsController } from '../supplier-payments/supplier-payments.controller';
import { UsersController } from '../users/users.controller';
import { WarehousesController } from '../warehouses/warehouses.controller';
import { ROLES_KEY } from './decorators/roles.decorator';

/**
 * R3 — matriz de roles de PURCHASING sobre Compras e Importaciones. Lee los
 * metadatos reales de @Roles() de cada ruta (nada se duplica a mano): si
 * alguien añade una ruta nueva sin decidir PURCHASING, o amplía una ruta
 * administrativa, esta prueba lo detecta.
 */

type Ctor = { prototype: object };

function routeRoles(ctor: Ctor): Map<string, RoleName[]> {
  const map = new Map<string, RoleName[]>();
  const proto = ctor.prototype as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const roles = Reflect.getMetadata(ROLES_KEY, proto[name] as object) as
      RoleName[] | undefined;
    if (roles !== undefined) map.set(name, roles);
  }
  return map;
}

/** Controladores de Compras/Importaciones: TODA ruta admite PURCHASING. */
const FULL_ACCESS: [string, Ctor][] = [
  ['SuppliersController (excepto ciclo de vida)', SuppliersController],
  ['PurchaseInvoicesController', PurchaseInvoicesController],
  ['PurchaseInvoiceReceiptsController', PurchaseInvoiceReceiptsController],
  ['PurchaseReceiptsController', PurchaseReceiptsController],
  ['PurchaseReceivingController', PurchaseReceivingController],
  ['SupplierPaymentsController', SupplierPaymentsController],
  ['AccountsPayableController', AccountsPayableController],
  ['ImportOperationsController', ImportOperationsController],
  ['ImportExpensesController', ImportExpensesController],
  ['ImportShipmentsController', ImportShipmentsController],
  ['ImportReportsController', ImportReportsController],
  [
    'ImportShipmentLineReceiptLinksController',
    ImportShipmentLineReceiptLinksController,
  ],
  ['ImportReceiptLinksController', ImportReceiptLinksController],
  [
    'ImportExpenseAllocationCostPreviewController',
    ImportExpenseAllocationCostPreviewController,
  ],
];

describe('R3 — PURCHASING en Compras e Importaciones (matriz de @Roles)', () => {
  it.each(FULL_ACCESS)(
    '%s: cada ruta admite PURCHASING y nunca SELLER',
    (name, ctor) => {
      const routes = routeRoles(ctor);
      expect(routes.size).toBeGreaterThan(0);
      for (const [method, roles] of routes) {
        if (
          ctor === SuppliersController &&
          (method === 'activate' || method === 'deactivate')
        ) {
          expect([method, roles]).toEqual([method, [RoleName.ADMIN]]);
          continue;
        }
        expect([method, roles.includes(RoleName.PURCHASING)]).toEqual([
          method,
          true,
        ]);
        expect([method, roles.includes(RoleName.SELLER)]).toEqual([
          method,
          false,
        ]);
      }
    },
  );

  it('las rutas de escritura de importaciones y pagos siguen sin MANAGEMENT ni ACCOUNTANT', () => {
    for (const ctor of [
      ImportOperationsController,
      ImportExpensesController,
      ImportShipmentsController,
      ImportReceiptLinksController,
      SupplierPaymentsController,
    ] as Ctor[]) {
      for (const [method, roles] of routeRoles(ctor)) {
        if (roles.includes(RoleName.ADMIN) && roles.length <= 2) {
          // escritura: ADMIN + PURCHASING exactamente
          expect([method, [...roles].sort()]).toEqual([
            method,
            [RoleName.ADMIN, RoleName.PURCHASING].sort(),
          ]);
        }
        expect(roles).not.toContain(RoleName.WAREHOUSE);
      }
    }
  });

  it('lecturas auxiliares: almacenes/ubicaciones y métodos de pago admiten PURCHASING; su administración no', () => {
    const wh = routeRoles(WarehousesController);
    for (const m of ['list', 'findOne', 'listLocations', 'findLocation']) {
      expect(wh.get(m)).toContain(RoleName.PURCHASING);
    }
    for (const [m, roles] of wh) {
      if (!['list', 'findOne', 'listLocations', 'findLocation'].includes(m)) {
        expect(roles).toEqual([RoleName.ADMIN]);
      }
    }
    const pm = routeRoles(PaymentMethodsController);
    expect(pm.get('list')).toContain(RoleName.PURCHASING);
    for (const [m, roles] of pm) {
      if (m !== 'list') expect(roles).toEqual([RoleName.ADMIN]);
    }
  });

  it('PURCHASING nunca aparece en usuarios, roles ni configuración', () => {
    for (const [, roles] of routeRoles(UsersController)) {
      expect(roles).not.toContain(RoleName.PURCHASING);
    }
  });
});

describe('R3 — guardia de servicio de importaciones', () => {
  const prisma = {
    importOperation: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const service = new ImportOperationsService(
    prisma as never,
    { record: jest.fn() } as never,
  );

  it('PURCHASING atraviesa la guardia de lectura (llega a la búsqueda y responde 404)', async () => {
    await expect(
      service.findOne('x', RoleName.PURCHASING),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('SELLER y WAREHOUSE siguen rechazados por el servicio sin tocar Prisma', async () => {
    prisma.importOperation.findUnique.mockClear();
    for (const role of [RoleName.SELLER, RoleName.WAREHOUSE]) {
      await expect(service.findOne('x', role)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
    expect(prisma.importOperation.findUnique).not.toHaveBeenCalled();
  });
});

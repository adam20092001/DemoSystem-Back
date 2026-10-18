import { NotFoundException } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import {
  applySaleReadScope,
  assertCanOperateSale,
  assertCanReadSale,
  canOperateSale,
  canReadSale,
  resolveSaleReadScope,
  SALE_NOT_FOUND_MESSAGE,
  SaleAccessRequester,
  saleReadScopeWhere,
} from './sale-access.policy';

const SELLER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SELLER_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const MANAGER_ID = '44444444-4444-4444-8444-444444444444';
const WAREHOUSE_ID = '55555555-5555-4555-8555-555555555555';

function requester(id: string, role: RoleName): SaleAccessRequester {
  return { id, role };
}

const seller = requester(SELLER_ID, RoleName.SELLER);
const admin = requester(ADMIN_ID, RoleName.ADMIN);
const management = requester(MANAGER_ID, RoleName.MANAGEMENT);
const warehouse = requester(WAREHOUSE_ID, RoleName.WAREHOUSE);

describe('sale-access.policy', () => {
  describe('SELLER', () => {
    it('alcance de lectura restringido a sus propias ventas (sellerId = actor.id)', () => {
      expect(resolveSaleReadScope(seller)).toEqual({
        kind: 'OWN',
        sellerId: SELLER_ID,
      });
      expect(saleReadScopeWhere(seller)).toEqual({ sellerId: SELLER_ID });
    });

    it('lee su propia venta: permitido', () => {
      expect(canReadSale(seller, SELLER_ID)).toBe(true);
      expect(() => assertCanReadSale(seller, SELLER_ID)).not.toThrow();
    });

    it('lee una venta ajena: denegado con 404 (nunca 403)', () => {
      expect(canReadSale(seller, OTHER_SELLER_ID)).toBe(false);
      expect(() => assertCanReadSale(seller, OTHER_SELLER_ID)).toThrow(
        new NotFoundException(SALE_NOT_FOUND_MESSAGE),
      );
    });

    it('opera su propia venta: permitido', () => {
      expect(canOperateSale(seller, SELLER_ID)).toBe(true);
      expect(() => assertCanOperateSale(seller, SELLER_ID)).not.toThrow();
    });

    it('opera una venta ajena: 404 con el mismo mensaje que una venta inexistente', () => {
      expect(canOperateSale(seller, OTHER_SELLER_ID)).toBe(false);
      expect(() => assertCanOperateSale(seller, OTHER_SELLER_ID)).toThrow(
        NotFoundException,
      );
      expect(() => assertCanOperateSale(seller, OTHER_SELLER_ID)).toThrow(
        SALE_NOT_FOUND_MESSAGE,
      );
    });

    it('el 404 puede reutilizar el mensaje de "inexistente" del servicio llamador', () => {
      expect(() =>
        assertCanOperateSale(seller, OTHER_SELLER_ID, 'La venta no existe'),
      ).toThrow(new NotFoundException('La venta no existe'));
      expect(() =>
        assertCanReadSale(seller, OTHER_SELLER_ID, 'La venta no existe'),
      ).toThrow(new NotFoundException('La venta no existe'));
    });
  });

  describe('ADMIN', () => {
    it('alcance de lectura completo (sin condición de vendedor)', () => {
      expect(resolveSaleReadScope(admin)).toEqual({ kind: 'ALL' });
      expect(saleReadScopeWhere(admin)).toEqual({});
    });

    it('lee y opera cualquier venta, propia o ajena', () => {
      expect(canReadSale(admin, OTHER_SELLER_ID)).toBe(true);
      expect(canOperateSale(admin, OTHER_SELLER_ID)).toBe(true);
      expect(() => assertCanReadSale(admin, SELLER_ID)).not.toThrow();
      expect(() => assertCanOperateSale(admin, SELLER_ID)).not.toThrow();
    });
  });

  describe('MANAGEMENT', () => {
    it('conserva la lectura completa vigente', () => {
      expect(resolveSaleReadScope(management)).toEqual({ kind: 'ALL' });
      expect(saleReadScopeWhere(management)).toEqual({});
      expect(canReadSale(management, OTHER_SELLER_ID)).toBe(true);
    });

    it('no obtiene permisos de operación, ni siquiera sobre ventas a su nombre', () => {
      expect(canOperateSale(management, OTHER_SELLER_ID)).toBe(false);
      expect(canOperateSale(management, MANAGER_ID)).toBe(false);
      expect(() => assertCanOperateSale(management, OTHER_SELLER_ID)).toThrow(
        NotFoundException,
      );
    });
  });

  describe('WAREHOUSE y roles no contemplados (falla cerrado)', () => {
    it('WAREHOUSE: sin alcance de lectura ni operación', () => {
      expect(resolveSaleReadScope(warehouse)).toEqual({ kind: 'NONE' });
      expect(saleReadScopeWhere(warehouse)).toBeNull();
      expect(canReadSale(warehouse, WAREHOUSE_ID)).toBe(false);
      expect(canOperateSale(warehouse, WAREHOUSE_ID)).toBe(false);
      expect(() => assertCanReadSale(warehouse, WAREHOUSE_ID)).toThrow(
        NotFoundException,
      );
    });

    it('un rol desconocido nunca hereda acceso', () => {
      const unknown = requester(SELLER_ID, 'AUDITOR' as RoleName);
      expect(resolveSaleReadScope(unknown)).toEqual({ kind: 'NONE' });
      expect(saleReadScopeWhere(unknown)).toBeNull();
      expect(canReadSale(unknown, SELLER_ID)).toBe(false);
      expect(canOperateSale(unknown, SELLER_ID)).toBe(false);
    });
  });

  describe('usuario con varios roles: se evalúa solo el rol ACTIVO', () => {
    it('el mismo usuario como SELLER queda restringido y como ADMIN no', () => {
      const asSeller = requester(SELLER_ID, RoleName.SELLER);
      const asAdmin = requester(SELLER_ID, RoleName.ADMIN);

      expect(canReadSale(asSeller, OTHER_SELLER_ID)).toBe(false);
      expect(canOperateSale(asSeller, OTHER_SELLER_ID)).toBe(false);
      expect(canReadSale(asAdmin, OTHER_SELLER_ID)).toBe(true);
      expect(canOperateSale(asAdmin, OTHER_SELLER_ID)).toBe(true);
    });

    it('el mismo usuario como MANAGEMENT lee pero no opera', () => {
      const asManagement = requester(SELLER_ID, RoleName.MANAGEMENT);
      expect(canReadSale(asManagement, OTHER_SELLER_ID)).toBe(true);
      expect(canOperateSale(asManagement, SELLER_ID)).toBe(false);
    });
  });

  describe('identidad: el vendedor siempre sale del usuario autenticado', () => {
    it('el alcance de SELLER usa requester.id y nunca un sellerId suministrado por el cliente', () => {
      const clientSuppliedSellerId = OTHER_SELLER_ID;
      const scoped = applySaleReadScope(seller, {
        sellerId: clientSuppliedSellerId,
      });
      expect(scoped).toEqual({
        AND: [{ sellerId: SELLER_ID }, { sellerId: clientSuppliedSellerId }],
      });
      // La condición obligatoria del alcance es la primera y no se reemplaza.
      expect((scoped as { AND: Prisma.SaleWhereInput[] }).AND[0]).toEqual({
        sellerId: SELLER_ID,
      });
    });

    it('la policy solo lee id y rol: campos extra del objeto no alteran el resultado', () => {
      const tampered = {
        id: SELLER_ID,
        role: RoleName.SELLER,
        sellerId: OTHER_SELLER_ID,
      } as SaleAccessRequester;
      expect(saleReadScopeWhere(tampered)).toEqual({ sellerId: SELLER_ID });
      expect(canReadSale(tampered, OTHER_SELLER_ID)).toBe(false);
    });
  });

  describe('composición con filtros solicitados (AND, nunca se amplía)', () => {
    it('SELLER sin filtros: sigue restringido a sus ventas (omitir sellerId no amplía)', () => {
      expect(applySaleReadScope(seller, {})).toEqual({
        AND: [{ sellerId: SELLER_ID }, {}],
      });
    });

    it('SELLER con filtros arbitrarios (OR, sellerId ajeno, otros campos): el alcance se conserva con AND', () => {
      const requested: Prisma.SaleWhereInput = {
        OR: [{ sellerId: OTHER_SELLER_ID }, { sellerId: { not: SELLER_ID } }],
        status: 'ACTIVE',
      };
      expect(applySaleReadScope(seller, requested)).toEqual({
        AND: [{ sellerId: SELLER_ID }, requested],
      });
    });

    it('ADMIN y MANAGEMENT: los filtros solicitados se aplican tal cual', () => {
      const requested: Prisma.SaleWhereInput = { sellerId: OTHER_SELLER_ID };
      expect(applySaleReadScope(admin, requested)).toBe(requested);
      expect(applySaleReadScope(management, requested)).toBe(requested);
    });

    it('sin acceso de lectura: null, para que el servicio responda vacío sin consultar', () => {
      expect(applySaleReadScope(warehouse, { sellerId: WAREHOUSE_ID })).toBe(
        null,
      );
    });
  });

  describe('lectura y operación son permisos separados', () => {
    it.each([
      [RoleName.ADMIN, true, true],
      [RoleName.MANAGEMENT, true, false],
      [RoleName.WAREHOUSE, false, false],
    ])(
      '%s sobre una venta ajena: lectura=%s, operación=%s',
      (role, canRead, canOperate) => {
        const r = requester(SELLER_ID, role);
        expect(canReadSale(r, OTHER_SELLER_ID)).toBe(canRead);
        expect(canOperateSale(r, OTHER_SELLER_ID)).toBe(canOperate);
      },
    );

    it('SELLER: lectura y operación coinciden (solo lo propio)', () => {
      expect(canReadSale(seller, SELLER_ID)).toBe(true);
      expect(canOperateSale(seller, SELLER_ID)).toBe(true);
      expect(canReadSale(seller, OTHER_SELLER_ID)).toBe(false);
      expect(canOperateSale(seller, OTHER_SELLER_ID)).toBe(false);
    });
  });
});

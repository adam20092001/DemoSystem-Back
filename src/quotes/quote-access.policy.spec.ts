import { NotFoundException } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import {
  applyQuoteReadScope,
  assertCanOperateQuote,
  assertCanReadQuote,
  canOperateQuote,
  canReadQuote,
  QUOTE_NOT_FOUND_MESSAGE,
  QuoteAccessRequester,
  quoteReadScopeWhere,
  resolveQuoteReadScope,
} from './quote-access.policy';

const SELLER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SELLER_ID = '22222222-2222-4222-8222-222222222222';

function requester(
  role: RoleName,
  id: string = SELLER_ID,
): QuoteAccessRequester {
  return { id, role };
}

const seller = requester(RoleName.SELLER);
const admin = requester(RoleName.ADMIN);
const management = requester(RoleName.MANAGEMENT);
const warehouse = requester(RoleName.WAREHOUSE);

describe('quote-access.policy', () => {
  describe('SELLER', () => {
    it('alcance restringido a Quote.sellerId = actor', () => {
      expect(resolveQuoteReadScope(seller)).toEqual({
        kind: 'OWN',
        sellerId: SELLER_ID,
      });
      expect(quoteReadScopeWhere(seller)).toEqual({ sellerId: SELLER_ID });
    });

    it('lee su propia cotización', () => {
      expect(canReadQuote(seller, SELLER_ID)).toBe(true);
      expect(() => assertCanReadQuote(seller, SELLER_ID)).not.toThrow();
    });

    it('no lee una cotización ajena: 404 con el mismo mensaje que una inexistente', () => {
      expect(canReadQuote(seller, OTHER_SELLER_ID)).toBe(false);
      expect(() => assertCanReadQuote(seller, OTHER_SELLER_ID)).toThrow(
        new NotFoundException(QUOTE_NOT_FOUND_MESSAGE),
      );
      expect(QUOTE_NOT_FOUND_MESSAGE).toBe('Cotización no encontrada');
    });

    it('operación (preparada para P6-B2): solo sobre cotizaciones propias', () => {
      expect(canOperateQuote(seller, SELLER_ID)).toBe(true);
      expect(canOperateQuote(seller, OTHER_SELLER_ID)).toBe(false);
      expect(() => assertCanOperateQuote(seller, OTHER_SELLER_ID)).toThrow(
        NotFoundException,
      );
    });
  });

  describe('ADMIN', () => {
    it('lectura completa y operación sin restricción de propiedad', () => {
      expect(resolveQuoteReadScope(admin)).toEqual({ kind: 'ALL' });
      expect(quoteReadScopeWhere(admin)).toEqual({});
      expect(canReadQuote(admin, OTHER_SELLER_ID)).toBe(true);
      expect(canOperateQuote(admin, OTHER_SELLER_ID)).toBe(true);
    });
  });

  describe('MANAGEMENT', () => {
    it('lectura completa sin ninguna autorización de operación', () => {
      expect(resolveQuoteReadScope(management)).toEqual({ kind: 'ALL' });
      expect(canReadQuote(management, OTHER_SELLER_ID)).toBe(true);
      expect(canOperateQuote(management, OTHER_SELLER_ID)).toBe(false);
      expect(canOperateQuote(management, SELLER_ID)).toBe(false);
      expect(() => assertCanOperateQuote(management, SELLER_ID)).toThrow(
        NotFoundException,
      );
    });
  });

  describe('WAREHOUSE y roles desconocidos (falla cerrado)', () => {
    it.each([RoleName.WAREHOUSE, 'AUDITOR' as RoleName])(
      '%s: sin lectura ni operación',
      (role) => {
        const r = requester(role);
        expect(resolveQuoteReadScope(r)).toEqual({ kind: 'NONE' });
        expect(quoteReadScopeWhere(r)).toBeNull();
        expect(applyQuoteReadScope(r, {})).toBeNull();
        expect(canReadQuote(r, SELLER_ID)).toBe(false);
        expect(canOperateQuote(r, SELLER_ID)).toBe(false);
        expect(() => assertCanReadQuote(r, SELLER_ID)).toThrow(
          NotFoundException,
        );
      },
    );

    it('warehouse explícito no obtiene alcance', () => {
      expect(quoteReadScopeWhere(warehouse)).toBeNull();
    });
  });

  describe('rol ACTIVO', () => {
    it('el mismo usuario como SELLER queda restringido; como ADMIN no', () => {
      expect(canReadQuote(requester(RoleName.SELLER), OTHER_SELLER_ID)).toBe(
        false,
      );
      expect(canReadQuote(requester(RoleName.ADMIN), OTHER_SELLER_ID)).toBe(
        true,
      );
    });
  });

  describe('composición con filtros (AND, nunca se amplía)', () => {
    it('sellerId manipulado no reemplaza el alcance del SELLER', () => {
      expect(
        applyQuoteReadScope(seller, { sellerId: OTHER_SELLER_ID }),
      ).toEqual({
        AND: [{ sellerId: SELLER_ID }, { sellerId: OTHER_SELLER_ID }],
      });
    });

    it('OR de búsqueda queda subordinado al alcance obligatorio', () => {
      const requested: Prisma.QuoteWhereInput = {
        OR: [{ sellerId: OTHER_SELLER_ID }, { number: { contains: 'COT' } }],
      };
      expect(applyQuoteReadScope(seller, requested)).toEqual({
        AND: [{ sellerId: SELLER_ID }, requested],
      });
    });

    it('omitir filtros no amplía el alcance del SELLER', () => {
      expect(applyQuoteReadScope(seller, {})).toEqual({
        AND: [{ sellerId: SELLER_ID }, {}],
      });
    });

    it('ADMIN/MANAGEMENT: filtros tal cual', () => {
      const requested: Prisma.QuoteWhereInput = { sellerId: OTHER_SELLER_ID };
      expect(applyQuoteReadScope(admin, requested)).toBe(requested);
      expect(applyQuoteReadScope(management, requested)).toBe(requested);
    });

    it('campos extra del solicitante se ignoran: solo cuentan id y rol', () => {
      const tampered = {
        id: SELLER_ID,
        role: RoleName.SELLER,
        sellerId: OTHER_SELLER_ID,
      } as QuoteAccessRequester;
      expect(quoteReadScopeWhere(tampered)).toEqual({ sellerId: SELLER_ID });
    });
  });
});

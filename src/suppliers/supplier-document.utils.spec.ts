import { BadRequestException } from '@nestjs/common';
import { SupplierDocumentType } from '@prisma/client';
import {
  assertValidDocumentFormat,
  normalizeCountryCode,
  normalizeDocumentNumber,
} from './supplier-document.utils';

describe('normalizeDocumentNumber', () => {
  it('recorta espacios y pasa a mayúsculas', () => {
    expect(normalizeDocumentNumber('  abc123  ')).toBe('ABC123');
  });

  it('string vacío tras trim: BadRequestException', () => {
    expect(() => normalizeDocumentNumber('   ')).toThrow(BadRequestException);
  });

  it('más de 32 caracteres: BadRequestException', () => {
    expect(() => normalizeDocumentNumber('a'.repeat(33))).toThrow(
      BadRequestException,
    );
  });

  it('exactamente 32 caracteres: no lanza', () => {
    expect(() => normalizeDocumentNumber('a'.repeat(32))).not.toThrow();
  });
});

describe('assertValidDocumentFormat', () => {
  it('RUC válido (11 dígitos): no lanza', () => {
    expect(() =>
      assertValidDocumentFormat(SupplierDocumentType.RUC, '20123456789'),
    ).not.toThrow();
  });

  it('RUC con menos de 11 dígitos: BadRequestException', () => {
    expect(() =>
      assertValidDocumentFormat(SupplierDocumentType.RUC, '2012345'),
    ).toThrow(BadRequestException);
  });

  it('RUC con letras: BadRequestException', () => {
    expect(() =>
      assertValidDocumentFormat(SupplierDocumentType.RUC, '2012345678A'),
    ).toThrow(BadRequestException);
  });

  it('DNI válido (8 dígitos): no lanza', () => {
    expect(() =>
      assertValidDocumentFormat(SupplierDocumentType.DNI, '12345678'),
    ).not.toThrow();
  });

  it('DNI con 7 dígitos: BadRequestException', () => {
    expect(() =>
      assertValidDocumentFormat(SupplierDocumentType.DNI, '1234567'),
    ).toThrow(BadRequestException);
  });

  it('FOREIGN_TAX_ID: cualquier texto no vacío es válido (sin forma fija entre países)', () => {
    expect(() =>
      assertValidDocumentFormat(
        SupplierDocumentType.FOREIGN_TAX_ID,
        'XYZ-99-ABC',
      ),
    ).not.toThrow();
  });

  it('OTHER: cualquier texto no vacío es válido', () => {
    expect(() =>
      assertValidDocumentFormat(SupplierDocumentType.OTHER, 'CUALQUIER-COSA'),
    ).not.toThrow();
  });
});

describe('normalizeCountryCode', () => {
  it('undefined resuelve al default "PE"', () => {
    expect(normalizeCountryCode(undefined)).toBe('PE');
  });

  it('minúsculas se normalizan a mayúsculas', () => {
    expect(normalizeCountryCode('us')).toBe('US');
  });

  it('con espacios perimetrales: se recortan', () => {
    expect(normalizeCountryCode('  cl  ')).toBe('CL');
  });

  it('más de 2 letras: BadRequestException', () => {
    expect(() => normalizeCountryCode('PER')).toThrow(BadRequestException);
  });

  it('con dígitos: BadRequestException', () => {
    expect(() => normalizeCountryCode('P3')).toThrow(BadRequestException);
  });

  it('una sola letra: BadRequestException', () => {
    expect(() => normalizeCountryCode('P')).toThrow(BadRequestException);
  });
});

import {
  businessToday,
  endOfBusinessDayExclusiveUtc,
  fromPrismaDate,
  isExpired,
  isValidDateOnly,
  startOfBusinessDayUtc,
  toPrismaDate,
} from './business-date';

describe('businessToday', () => {
  it('formatea como YYYY-MM-DD', () => {
    const result = businessToday(new Date('2026-03-15T18:00:00.000Z'));
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('un instante ya en el siguiente día UTC pero aún en el día calendario previo en Lima devuelve la fecha de Lima', () => {
    // 2026-03-02T02:00:00Z es 2026-03-01 21:00 en America/Lima (UTC-5):
    // ya es "2 de marzo" en UTC, pero todavía "1 de marzo" en Lima.
    const result = businessToday(new Date('2026-03-02T02:00:00.000Z'));
    expect(result).toBe('2026-03-01');
  });

  it('un instante en la madrugada UTC del mismo día calendario en Lima', () => {
    // 2026-03-01T10:00:00Z es 2026-03-01 05:00 en Lima: mismo día en ambos.
    const result = businessToday(new Date('2026-03-01T10:00:00.000Z'));
    expect(result).toBe('2026-03-01');
  });

  it('sin argumento usa la hora actual real (no lanza, formato válido)', () => {
    const result = businessToday();
    expect(isValidDateOnly(result)).toBe(true);
  });
});

describe('isValidDateOnly', () => {
  it('fecha bisiesta válida (2024-02-29) es válida', () => {
    expect(isValidDateOnly('2024-02-29')).toBe(true);
  });

  it('29 de febrero en año no bisiesto (2023) es inválida', () => {
    expect(isValidDateOnly('2023-02-29')).toBe(false);
  });

  it('30 de febrero es inválida en cualquier año', () => {
    expect(isValidDateOnly('2026-02-30')).toBe(false);
    expect(isValidDateOnly('2024-02-30')).toBe(false);
  });

  it('otra fecha bisiesta válida (2000-02-29)', () => {
    expect(isValidDateOnly('2000-02-29')).toBe(true);
  });

  it('fecha regular válida', () => {
    expect(isValidDateOnly('2026-01-15')).toBe(true);
  });

  it.each([
    '2026-1-1',
    '2026/01/01',
    '20260101',
    '',
    'no-es-fecha',
    '2026-13-01',
    '2026-01-32',
  ])('formato/calendario inválido %j es rechazado', (value) => {
    expect(isValidDateOnly(value)).toBe(false);
  });
});

describe('toPrismaDate', () => {
  it('representa medianoche UTC exacta', () => {
    const result = toPrismaDate('2026-03-15');
    expect(result.toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });

  it('lanza BadRequestException para una fecha inválida', () => {
    expect(() => toPrismaDate('2026-02-30')).toThrow();
  });

  it('lanza BadRequestException para formato inválido', () => {
    expect(() => toPrismaDate('15-03-2026')).toThrow();
  });
});

describe('fromPrismaDate', () => {
  it('usa componentes UTC, no locales', () => {
    const date = new Date('2026-03-15T00:00:00.000Z');
    expect(fromPrismaDate(date)).toBe('2026-03-15');
  });
});

describe('roundtrip toPrismaDate <-> fromPrismaDate', () => {
  it.each(['2026-01-01', '2026-12-31', '2024-02-29', '2026-06-15'])(
    '%s se preserva exactamente tras el roundtrip',
    (value) => {
      expect(fromPrismaDate(toPrismaDate(value))).toBe(value);
    },
  );
});

describe('isExpired', () => {
  it('expirationDate igual a businessDate: NO vencida', () => {
    expect(isExpired('2026-03-15', '2026-03-15')).toBe(false);
  });

  it('expirationDate un día antes de businessDate: vencida', () => {
    expect(isExpired('2026-03-14', '2026-03-15')).toBe(true);
  });

  it('expirationDate en el futuro respecto a businessDate: NO vencida', () => {
    expect(isExpired('2026-03-16', '2026-03-15')).toBe(false);
  });

  it('acepta un Date (columna @db.Date) además de un string', () => {
    const expirationDate = toPrismaDate('2026-03-14');
    expect(isExpired(expirationDate, '2026-03-15')).toBe(true);
  });
});

describe('startOfBusinessDayUtc', () => {
  it('la medianoche de Lima corresponde a las 05:00 UTC del mismo día calendario', () => {
    const result = startOfBusinessDayUtc('2026-03-15');
    expect(result.toISOString()).toBe('2026-03-15T05:00:00.000Z');
  });

  it('lanza BadRequestException para una fecha inválida (30 de febrero)', () => {
    expect(() => startOfBusinessDayUtc('2026-02-30')).toThrow();
  });

  it('lanza BadRequestException para formato inválido', () => {
    expect(() => startOfBusinessDayUtc('15-03-2026')).toThrow();
  });

  it('funciona en el cambio de año calendario', () => {
    const result = startOfBusinessDayUtc('2026-01-01');
    expect(result.toISOString()).toBe('2026-01-01T05:00:00.000Z');
  });
});

describe('endOfBusinessDayExclusiveUtc', () => {
  it('es el inicio del día de negocio SIGUIENTE, no el mismo día', () => {
    const result = endOfBusinessDayExclusiveUtc('2026-03-15');
    expect(result.toISOString()).toBe('2026-03-16T05:00:00.000Z');
  });

  it('cruza correctamente el fin de mes', () => {
    const result = endOfBusinessDayExclusiveUtc('2026-01-31');
    expect(result.toISOString()).toBe('2026-02-01T05:00:00.000Z');
  });

  it('lanza BadRequestException para una fecha inválida', () => {
    expect(() => endOfBusinessDayExclusiveUtc('2026-02-30')).toThrow();
  });

  it('un instante confirmado a las 23:00 hora Lima del día "hasta" queda incluido en el rango [desde, hasta)', () => {
    // 2026-03-15 23:00 en Lima (UTC-5) = 2026-03-16 04:00 UTC: todavía antes
    // del inicio del día siguiente (2026-03-16T05:00:00Z), así que un filtro
    // confirmedAt < endOfBusinessDayExclusiveUtc('2026-03-15') lo incluye.
    const confirmedAt = new Date('2026-03-16T04:00:00.000Z');
    const exclusiveEnd = endOfBusinessDayExclusiveUtc('2026-03-15');
    expect(confirmedAt.getTime() < exclusiveEnd.getTime()).toBe(true);
  });

  it('un instante ya en el día de negocio siguiente en Lima queda excluido', () => {
    // 2026-03-16 00:00 en Lima = 2026-03-16 05:00 UTC: ya es el día
    // siguiente en Lima, debe quedar excluido del filtro sobre "2026-03-15".
    const confirmedAt = new Date('2026-03-16T05:00:00.000Z');
    const exclusiveEnd = endOfBusinessDayExclusiveUtc('2026-03-15');
    expect(confirmedAt.getTime() < exclusiveEnd.getTime()).toBe(false);
  });
});

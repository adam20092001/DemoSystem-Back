import { calculateDaysOutstanding } from './receivable-calculator';

describe('calculateDaysOutstanding', () => {
  it('misma fecha de negocio -> 0', () => {
    expect(
      calculateDaysOutstanding(
        new Date('2026-03-15T14:00:00.000Z'),
        '2026-03-15',
      ),
    ).toBe(0);
  });

  it('un día antes -> 1', () => {
    expect(
      calculateDaysOutstanding(
        new Date('2026-03-14T14:00:00.000Z'),
        '2026-03-15',
      ),
    ).toBe(1);
  });

  it('varios días antes -> N', () => {
    expect(
      calculateDaysOutstanding(
        new Date('2026-03-01T14:00:00.000Z'),
        '2026-03-15',
      ),
    ).toBe(14);
  });

  it('fecha futura (corrupta) -> nunca negativo, se recorta a 0', () => {
    expect(
      calculateDaysOutstanding(
        new Date('2026-03-20T14:00:00.000Z'),
        '2026-03-15',
      ),
    ).toBe(0);
  });

  it('usa businessToday() por defecto cuando no se pasa el segundo argumento', () => {
    const now = new Date();
    // confirmedAt = ahora mismo -> la fecha de negocio coincide con hoy -> 0.
    expect(calculateDaysOutstanding(now)).toBe(0);
  });

  it('interpreta confirmedAt a través del calendario de negocio America/Lima (instante cercano a medianoche UTC)', () => {
    // 2026-03-15T02:00:00Z corresponde a 2026-03-14 21:00 en America/Lima
    // (UTC-5 fijo): la fecha de negocio sigue siendo el 14, no el 15.
    expect(
      calculateDaysOutstanding(
        new Date('2026-03-15T02:00:00.000Z'),
        '2026-03-15',
      ),
    ).toBe(1);
  });
});

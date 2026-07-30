import { toStrictBoolean } from './to-strict-boolean.transform';

describe('toStrictBoolean', () => {
  it('boolean true permanece true', () => {
    expect(toStrictBoolean({ value: true })).toBe(true);
  });

  it('boolean false permanece false', () => {
    expect(toStrictBoolean({ value: false })).toBe(false);
  });

  it('string "true" se transforma a true', () => {
    expect(toStrictBoolean({ value: 'true' })).toBe(true);
  });

  it('string "false" se transforma a false (no a true, a diferencia de Boolean("false"))', () => {
    expect(toStrictBoolean({ value: 'false' })).toBe(false);
  });

  it('undefined permanece undefined', () => {
    expect(toStrictBoolean({ value: undefined })).toBeUndefined();
  });

  it.each(['yes', '0', '1', '', 'abc'])(
    'valor inválido %j se conserva sin convertirse silenciosamente',
    (value) => {
      expect(toStrictBoolean({ value })).toBe(value);
    },
  );
});

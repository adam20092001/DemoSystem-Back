import { sanitizeExcelString } from './sanitize-excel-string';

describe('sanitizeExcelString', () => {
  it('texto normal: no se modifica', () => {
    expect(sanitizeExcelString('Cliente Uno SAC')).toBe('Cliente Uno SAC');
  });

  it.each(['=', '+', '-', '@', '\t', '\r'])(
    'prefijo peligroso "%s": antepone comilla simple al valor ORIGINAL',
    (prefix) => {
      const value = `${prefix}cmd|/C calc`;
      expect(sanitizeExcelString(value)).toBe(`'${value}`);
    },
  );

  it('espacios simples antes del prefijo peligroso: igual se neutraliza', () => {
    const value = '   =SUM(A1:A9)';
    expect(sanitizeExcelString(value)).toBe(`'${value}`);
  });

  it('tabulador o retorno de carro iniciales son peligrosos por sí mismos, incluso sin fórmula después', () => {
    expect(sanitizeExcelString('\tHola')).toBe("'\tHola");
    expect(sanitizeExcelString('\rHola')).toBe("'\rHola");
  });

  it('un guion legítimo en texto libre también se neutraliza (criterio literal aprobado, no solo fórmulas)', () => {
    expect(sanitizeExcelString('-5 unidades dañadas')).toBe(
      "'-5 unidades dañadas",
    );
  });

  it('cadena vacía: se conserva igual', () => {
    expect(sanitizeExcelString('')).toBe('');
  });

  it('espacio intermedio (no inicial) antes de un carácter peligroso: no se neutraliza', () => {
    expect(sanitizeExcelString('Total =100')).toBe('Total =100');
  });

  it('solo espacios, sin carácter peligroso después: no se neutraliza', () => {
    expect(sanitizeExcelString('   ')).toBe('   ');
  });
});

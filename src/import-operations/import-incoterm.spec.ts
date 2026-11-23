import { ImportIncoterm, ImportTransportMode } from '@prisma/client';
import {
  EMPTY_INCOTERM_STATE,
  IncotermState,
  MARITIME_ONLY_INCOTERMS,
  resolveIncotermState,
} from './import-incoterm';

const NO_CHANGE = { transportModeChanged: false };

describe('Incoterm de embarques (R4)', () => {
  it('los once códigos de Incoterms 2020 existen', () => {
    expect(Object.values(ImportIncoterm).sort()).toEqual(
      [
        'CFR',
        'CIF',
        'CIP',
        'CPT',
        'DAP',
        'DDP',
        'DPU',
        'EXW',
        'FAS',
        'FCA',
        'FOB',
      ].sort(),
    );
  });

  it('solo FAS, FOB, CFR y CIF son exclusivos del transporte marítimo', () => {
    expect([...MARITIME_ONLY_INCOTERMS].sort()).toEqual([
      'CFR',
      'CIF',
      'FAS',
      'FOB',
    ]);
  });

  it('sin incoterm: nada se asigna automáticamente (ni lugar ni versión)', () => {
    expect(
      resolveIncotermState(
        EMPTY_INCOTERM_STATE,
        {},
        ImportTransportMode.SEA,
        NO_CHANGE,
      ),
    ).toEqual(EMPTY_INCOTERM_STATE);
  });

  it('con incoterm y lugar, sin versión: versión 2020', () => {
    expect(
      resolveIncotermState(
        EMPTY_INCOTERM_STATE,
        { incoterm: ImportIncoterm.FOB, incotermNamedPlace: '  Shanghai  ' },
        ImportTransportMode.SEA,
        NO_CHANGE,
      ),
    ).toEqual({
      incoterm: 'FOB',
      incotermNamedPlace: 'Shanghai',
      incotermVersion: '2020',
    });
  });

  it('con incoterm y sin lugar: 400 (campo incotermNamedPlace)', () => {
    expect(() =>
      resolveIncotermState(
        EMPTY_INCOTERM_STATE,
        { incoterm: ImportIncoterm.EXW },
        ImportTransportMode.LAND,
        NO_CHANGE,
      ),
    ).toThrow(/lugar o puerto/);
  });

  it.each(['FAS', 'FOB', 'CFR', 'CIF'] as const)(
    '%s con transporte no marítimo: 400',
    (code) => {
      for (const mode of [
        ImportTransportMode.AIR,
        ImportTransportMode.LAND,
        ImportTransportMode.OTHER,
      ]) {
        expect(() =>
          resolveIncotermState(
            EMPTY_INCOTERM_STATE,
            { incoterm: code, incotermNamedPlace: 'Callao' },
            mode,
            NO_CHANGE,
          ),
        ).toThrow(/marítimo/);
      }
    },
  );

  it.each(['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const)(
    '%s es válido con cualquier modo de transporte',
    (code) => {
      for (const mode of Object.values(ImportTransportMode)) {
        expect(
          resolveIncotermState(
            EMPTY_INCOTERM_STATE,
            { incoterm: code, incotermNamedPlace: 'Lima' },
            mode,
            NO_CHANGE,
          ).incoterm,
        ).toBe(code);
      }
    },
  );

  it('cambiar el modo a no marítimo con un FOB vigente: 400 atribuido a transportMode', () => {
    const current: IncotermState = {
      incoterm: ImportIncoterm.FOB,
      incotermNamedPlace: 'Shanghai',
      incotermVersion: '2020',
    };
    try {
      resolveIncotermState(current, {}, ImportTransportMode.AIR, {
        transportModeChanged: true,
      });
      throw new Error('debió fallar');
    } catch (e) {
      const body = (
        e as { getResponse: () => { errors: { field: string }[] } }
      ).getResponse();
      expect(body.errors[0].field).toBe('transportMode');
    }
  });

  it('limpiar el incoterm (null) borra lugar y versión', () => {
    const current: IncotermState = {
      incoterm: ImportIncoterm.CIF,
      incotermNamedPlace: 'Callao',
      incotermVersion: '2020',
    };
    expect(
      resolveIncotermState(
        current,
        { incoterm: null },
        ImportTransportMode.SEA,
        NO_CHANGE,
      ),
    ).toEqual(EMPTY_INCOTERM_STATE);
  });

  it('lugar o versión sin incoterm: 400', () => {
    expect(() =>
      resolveIncotermState(
        EMPTY_INCOTERM_STATE,
        { incotermNamedPlace: 'Callao' },
        ImportTransportMode.SEA,
        NO_CHANGE,
      ),
    ).toThrow(/sin un incoterm/);
    expect(() =>
      resolveIncotermState(
        EMPTY_INCOTERM_STATE,
        { incotermVersion: '2020' },
        ImportTransportMode.SEA,
        NO_CHANGE,
      ),
    ).toThrow(/sin un incoterm/);
  });

  it('versión no soportada: 400', () => {
    expect(() =>
      resolveIncotermState(
        EMPTY_INCOTERM_STATE,
        {
          incoterm: ImportIncoterm.DAP,
          incotermNamedPlace: 'Lima',
          incotermVersion: '2010',
        },
        ImportTransportMode.LAND,
        NO_CHANGE,
      ),
    ).toThrow(/no soportada/);
  });
});

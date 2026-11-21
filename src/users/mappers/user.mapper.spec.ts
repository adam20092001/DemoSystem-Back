import { RoleName } from '@prisma/client';
import { sortRolesForPresentation } from './user.mapper';

describe('sortRolesForPresentation', () => {
  it('R1: ordena ADMIN, MANAGEMENT, ACCOUNTANT, PURCHASING, WAREHOUSE, SELLER', () => {
    expect(
      sortRolesForPresentation([
        RoleName.SELLER,
        RoleName.PURCHASING,
        RoleName.ACCOUNTANT,
        RoleName.WAREHOUSE,
        RoleName.MANAGEMENT,
        RoleName.ADMIN,
      ]),
    ).toEqual([
      RoleName.ADMIN,
      RoleName.MANAGEMENT,
      RoleName.ACCOUNTANT,
      RoleName.PURCHASING,
      RoleName.WAREHOUSE,
      RoleName.SELLER,
    ]);
  });

  it('ACCOUNTANT ya no queda primero por índice -1 (omisión corregida de la Fase A4)', () => {
    expect(
      sortRolesForPresentation([RoleName.WAREHOUSE, RoleName.ACCOUNTANT]),
    ).toEqual([RoleName.ACCOUNTANT, RoleName.WAREHOUSE]);
    expect(
      sortRolesForPresentation([RoleName.ADMIN, RoleName.ACCOUNTANT]),
    ).toEqual([RoleName.ADMIN, RoleName.ACCOUNTANT]);
  });

  it('todo valor de RoleName tiene una posición de presentación definida (sin omisiones futuras)', () => {
    const all = Object.values(RoleName);
    const sorted = sortRolesForPresentation([...all].reverse());
    expect([...sorted].sort()).toEqual([...all].sort());
    // Si faltara alguno en ROLE_PRESENTATION_ORDER su índice sería -1 y
    // quedaría siempre primero; ADMIN debe seguir siendo el primero.
    expect(sorted[0]).toBe(RoleName.ADMIN);
  });

  it('no muta el arreglo recibido', () => {
    const input = [RoleName.SELLER, RoleName.ADMIN];
    sortRolesForPresentation(input);
    expect(input).toEqual([RoleName.SELLER, RoleName.ADMIN]);
  });
});

import { InternalServerErrorException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { resolveDefaultActiveRole } from './default-active-role';

describe('resolveDefaultActiveRole', () => {
  it('prioriza SELLER sobre cualquier otro rol asignado', () => {
    expect(resolveDefaultActiveRole([RoleName.ADMIN, RoleName.SELLER])).toBe(
      RoleName.SELLER,
    );
  });

  it('WAREHOUSE tiene prioridad sobre MANAGEMENT/ACCOUNTANT/ADMIN', () => {
    expect(
      resolveDefaultActiveRole([
        RoleName.WAREHOUSE,
        RoleName.MANAGEMENT,
        RoleName.ACCOUNTANT,
        RoleName.ADMIN,
      ]),
    ).toBe(RoleName.WAREHOUSE);
  });

  it('MANAGEMENT tiene prioridad sobre ACCOUNTANT/ADMIN', () => {
    expect(
      resolveDefaultActiveRole([
        RoleName.MANAGEMENT,
        RoleName.ACCOUNTANT,
        RoleName.ADMIN,
      ]),
    ).toBe(RoleName.MANAGEMENT);
  });

  it('Fase A4.1: ACCOUNTANT como único rol resuelve a ACCOUNTANT, nunca lanza (regresión del hallazgo: antes de A4.1 esta lista no lo incluía y el login de un ACCOUNTANT fallaba con 500)', () => {
    expect(resolveDefaultActiveRole([RoleName.ACCOUNTANT])).toBe(
      RoleName.ACCOUNTANT,
    );
  });

  it('ACCOUNTANT tiene prioridad sobre ADMIN', () => {
    expect(
      resolveDefaultActiveRole([RoleName.ACCOUNTANT, RoleName.ADMIN]),
    ).toBe(RoleName.ACCOUNTANT);
  });

  it('R1: PURCHASING como único rol resuelve a PURCHASING, nunca lanza (el usuario solo-PURCHASING debe poder iniciar sesión)', () => {
    expect(resolveDefaultActiveRole([RoleName.PURCHASING])).toBe(
      RoleName.PURCHASING,
    );
  });

  it('R1: PURCHASING tiene prioridad sobre MANAGEMENT/ACCOUNTANT/ADMIN (menos privilegiado primero) pero cede ante SELLER y WAREHOUSE', () => {
    expect(
      resolveDefaultActiveRole([
        RoleName.ADMIN,
        RoleName.ACCOUNTANT,
        RoleName.MANAGEMENT,
        RoleName.PURCHASING,
      ]),
    ).toBe(RoleName.PURCHASING);
    expect(
      resolveDefaultActiveRole([RoleName.PURCHASING, RoleName.WAREHOUSE]),
    ).toBe(RoleName.WAREHOUSE);
    expect(
      resolveDefaultActiveRole([RoleName.PURCHASING, RoleName.SELLER]),
    ).toBe(RoleName.SELLER);
  });

  it('todo valor de RoleName tiene un camino de login: cada rol, como único asignado, resuelve a sí mismo', () => {
    for (const role of Object.values(RoleName)) {
      expect(resolveDefaultActiveRole([role])).toBe(role);
    }
  });

  it('ADMIN como único rol resuelve a ADMIN', () => {
    expect(resolveDefaultActiveRole([RoleName.ADMIN])).toBe(RoleName.ADMIN);
  });

  it('sin ningún rol asignado: InternalServerErrorException (invariante de negocio violada, nunca inventa un rol por defecto)', () => {
    expect(() => resolveDefaultActiveRole([])).toThrow(
      InternalServerErrorException,
    );
  });
});

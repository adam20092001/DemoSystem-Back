import { UnitStatus } from '@prisma/client';

/** Forma de unidad de medida segura para salir del dominio. */
export interface SafeUnit {
  id: string;
  code: string;
  name: string;
  abbreviation: string;
  allowDecimal: boolean;
  status: UnitStatus;
  createdAt: Date;
  updatedAt: Date;
}

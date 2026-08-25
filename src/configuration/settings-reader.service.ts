import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaExecutionClient } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { CompanySettingsSnapshot } from './types/company-settings-snapshot';

/**
 * Puerto de solo lectura hacia CompanySettings para el resto del dominio
 * (Cotizaciones/Ventas, Bloques B/C). Deliberadamente estrecho: expone solo
 * los campos que la lógica de negocio necesita (moneda, IGV, vigencia de
 * cotización, descuento máximo permitido), nunca los campos de identidad de
 * la empresa. Acepta un cliente de transacción opcional para que el
 * llamador lea la configuración dentro de su propia transacción abierta,
 * mismo criterio que AuditService.record().
 *
 * Sin lógica de "crear si falta": la ausencia de la fila singleton tras el
 * seed es una violación de invariante interna (500), nunca un caso de
 * negocio a resolver aquí.
 */
@Injectable()
export class SettingsReader {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrent(
    client?: PrismaExecutionClient,
  ): Promise<CompanySettingsSnapshot> {
    const db = client ?? this.prisma;
    const row = await db.companySettings.findUnique({
      where: { singleton: true },
      select: {
        currencyCode: true,
        currencySymbol: true,
        taxEnabled: true,
        taxRate: true,
        quoteValidityDays: true,
        maxDiscountPercent: true,
      },
    });
    if (row === null) {
      throw new InternalServerErrorException(
        'Configuración de la empresa no inicializada: falta la fila singleton de company_settings',
      );
    }
    return row;
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  PAYMENT_METHOD_SAFE_SELECT,
  toSafePaymentMethod,
} from './mappers/payment-method.mapper';
import { SafePaymentMethod } from './types/safe-payment-method';

/**
 * Lector angosto de solo lectura, diseñado en el Bloque C2 para el uso que
 * el Bloque C3 le da hoy: PaymentEngine.register() lo inyecta (vía
 * PaymentMethodsModule) para resolver `code -> PaymentMethod` dentro de su
 * propia transacción de cobro (`findByCode(code, tx)`). Existe como un
 * servicio SEPARADO de PaymentMethodsService a propósito:
 * PaymentMethodsService.listPaymentMethods() está diseñado para el caso de
 * uso HTTP administrativo (recibe `requesterRole` y aplica autorización
 * basada en rol); la consulta interna de dominio que hace PaymentEngine
 * ("¿este code existe y está activo?", para resolver un cobro) no tiene
 * ningún rol de solicitante que evaluar — es una regla de negocio, no una
 * petición HTTP. Reutilizar PaymentMethodsService para eso forzaría a
 * PaymentEngine a inventar un rol falso solo para pasar la autorización,
 * mezclando dos preocupaciones distintas. Este lector, en cambio, no aplica
 * ninguna autorización: cualquier módulo que lo inyecte ya pasó su propia
 * autorización HTTP antes de necesitar esta consulta interna, igual que
 * SettingsReader (ConfigurationModule).
 *
 * Se exporta desde PaymentMethodsModule; PaymentsModule lo importa (ver
 * payments.module.ts) sin reestructurar ninguno de los dos módulos —
 * mismo precedente que SettingsReader (Fase 10, Bloque A) siguió para
 * QuotesModule/SalesModule.
 */
@Injectable()
export class PaymentMethodReader {
  constructor(private readonly prisma: PrismaService) {}

  /** Cualquier método por code (activo o inactivo), o null si no existe. */
  async findByCode(
    code: string,
    client?: Prisma.TransactionClient,
  ): Promise<SafePaymentMethod | null> {
    const db = client ?? this.prisma;
    const row = await db.paymentMethod.findUnique({
      where: { code },
      select: PAYMENT_METHOD_SAFE_SELECT,
    });
    return row === null ? null : toSafePaymentMethod(row);
  }

  /** Igual que findByCode(), pero null también si el método existe pero está inactivo. */
  async findActiveByCode(
    code: string,
    client?: Prisma.TransactionClient,
  ): Promise<SafePaymentMethod | null> {
    const row = await this.findByCode(code, client);
    return row !== null && row.active ? row : null;
  }

  /** Métodos activos, mismo orden que PaymentMethodsService.listPaymentMethods() sin includeInactive. */
  async listActive(
    client?: Prisma.TransactionClient,
  ): Promise<SafePaymentMethod[]> {
    const db = client ?? this.prisma;
    const rows = await db.paymentMethod.findMany({
      where: { active: true },
      select: PAYMENT_METHOD_SAFE_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { code: 'asc' }],
    });
    return rows.map(toSafePaymentMethod);
  }
}

import { Module } from '@nestjs/common';
import { CashSessionReader } from './cash-session-reader.service';
import { CashSessionsController } from './cash-sessions.controller';
import { CashSessionsService } from './cash-sessions.service';

/**
 * PrismaService y AuditService llegan de módulos globales (Database, Audit),
 * mismo criterio que PaymentMethodsModule.
 *
 * Ticket B, Bloque B4: exporta CashSessionReader para que PaymentsModule lo
 * importe (ver payments.module.ts) y PaymentEngine.register() pueda
 * bloquear la caja del cobrador dentro de su propia transacción — mismo
 * precedente que PaymentMethodReader vía PaymentMethodsModule.
 * CashSessionsModule sigue sin importar PaymentsModule (ni ningún otro
 * módulo del dominio de ventas/pagos): la dependencia va en un solo
 * sentido, sin ciclo.
 */
@Module({
  controllers: [CashSessionsController],
  providers: [CashSessionsService, CashSessionReader],
  exports: [CashSessionReader],
})
export class CashSessionsModule {}

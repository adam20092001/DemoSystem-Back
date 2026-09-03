import { Module } from '@nestjs/common';
import { PaymentMethodReader } from './payment-method-reader.service';
import { PaymentMethodsController } from './payment-methods.controller';
import { PaymentMethodsService } from './payment-methods.service';

/**
 * PrismaService y AuditService llegan de módulos globales (Database, Audit).
 * PaymentMethodReader se exporta (desde el Bloque C2) y, desde el Bloque
 * C3, PaymentsModule importa este módulo para que PaymentEngine pueda
 * inyectarlo — mismo precedente que SettingsReader en ConfigurationModule.
 * PaymentMethodsModule es una hoja del grafo de dependencias (no importa
 * Payments/Sales/Accounting): la dependencia va en un solo sentido, sin
 * ciclo.
 */
@Module({
  controllers: [PaymentMethodsController],
  providers: [PaymentMethodsService, PaymentMethodReader],
  exports: [PaymentMethodReader],
})
export class PaymentMethodsModule {}

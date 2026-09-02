import { Module } from '@nestjs/common';
import { PaymentMethodReader } from './payment-method-reader.service';
import { PaymentMethodsController } from './payment-methods.controller';
import { PaymentMethodsService } from './payment-methods.service';

/**
 * PrismaService y AuditService llegan de módulos globales (Database, Audit).
 * PaymentMethodReader se exporta desde ya (Bloque C2) para que el Bloque
 * C3 pueda importar este módulo desde PaymentsModule sin reestructurarlo —
 * mismo precedente que SettingsReader en ConfigurationModule. Ningún otro
 * módulo lo importa todavía: PaymentMethodsModule no participa hoy del
 * grafo de dependencias de Payments/Sales/Accounting.
 */
@Module({
  controllers: [PaymentMethodsController],
  providers: [PaymentMethodsService, PaymentMethodReader],
  exports: [PaymentMethodReader],
})
export class PaymentMethodsModule {}

import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { PaymentMethodsModule } from '../payment-methods/payment-methods.module';
import { AccountsReceivableController } from './accounts-receivable.controller';
import { AccountsReceivableService } from './accounts-receivable.service';
import { PaymentEngine } from './payment.engine';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * PrismaService y AuditService llegan de módulos globales (Database,
 * Audit). PaymentsModule es el ÚNICO propietario de PaymentEngine (Bloque
 * C: reemplaza el registro temporal directo en SalesModule.providers del
 * Bloque B). Se exporta PaymentEngine para que SalesModule lo reutilice
 * dentro de su propia transacción (pago inicial, anulación en cascada),
 * mismo patrón ya usado por InventoryModule con StockMovementEngine.
 * PaymentsModule NUNCA importa SalesModule: AccountsReceivableService lee
 * `sales` directamente vía PrismaService (mismo precedente arquitectónico
 * que SalesService usa para Quote, D17 de la Fase 6) — ninguna dependencia
 * en sentido inverso, sin forwardRef, sin ciclo. PaymentsService no se
 * exporta: ningún otro módulo la necesita todavía.
 *
 * Desde la Fase 8, Bloque B: importa AccountingModule para que PaymentEngine
 * pueda componer AccountingEngine dentro de su propia transacción (asiento
 * de cobro / reversión de pago). AccountingModule es hoja (no importa
 * PaymentsModule ni SalesModule), así que no hay ciclo. AccountingEngine
 * NUNCA se registra manualmente aquí en `providers`: AccountingModule es su
 * único propietario.
 *
 * Ticket C, Bloque C3: importa PaymentMethodsModule para que PaymentEngine
 * pueda inyectar PaymentMethodReader y resolver el método dinámico dentro
 * de su propia transacción (register()). PaymentMethodsModule también es
 * hoja (no importa PaymentsModule ni SalesModule) — mismo criterio que
 * AccountingModule, sin ciclo. PaymentMethodReader NUNCA se registra
 * manualmente aquí en `providers`: PaymentMethodsModule es su único
 * propietario, solo se reutiliza vía `exports`.
 */
@Module({
  imports: [AccountingModule, PaymentMethodsModule],
  controllers: [PaymentsController, AccountsReceivableController],
  providers: [PaymentEngine, PaymentsService, AccountsReceivableService],
  exports: [PaymentEngine],
})
export class PaymentsModule {}

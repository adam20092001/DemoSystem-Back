import { Module } from '@nestjs/common';
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
 */
@Module({
  controllers: [PaymentsController, AccountsReceivableController],
  providers: [PaymentEngine, PaymentsService, AccountsReceivableService],
  exports: [PaymentEngine],
})
export class PaymentsModule {}

import { Module } from '@nestjs/common';
import { AccountingEngine } from './accounting.engine';

/**
 * Módulo de dominio puro (Fase 8, Bloque B): sin controllers todavía (eso
 * llega en el Bloque C). PrismaService/AuditService llegan de módulos
 * globales (Database, Audit). AccountingModule es hoja: no importa
 * SalesModule ni PaymentsModule — ambos lo importan a él (PaymentsModule
 * para que PaymentEngine componga AccountingEngine; SalesModule para que
 * SalesService lo haga directamente), mismo patrón ya usado por
 * InventoryModule con StockMovementEngine. Sin forwardRef, sin ciclo:
 * AccountingModule es el ÚNICO propietario del provider AccountingEngine —
 * ningún otro módulo lo registra manualmente en su propio `providers`.
 */
@Module({
  providers: [AccountingEngine],
  exports: [AccountingEngine],
})
export class AccountingModule {}

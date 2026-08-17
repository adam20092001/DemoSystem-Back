import { Module } from '@nestjs/common';
import { AccountingEngine } from './accounting.engine';
import { AccountingEntriesController } from './accounting-entries.controller';
import { AccountingService } from './accounting.service';
import { AccountsController } from './accounts.controller';

/**
 * PrismaService/AuditService llegan de módulos globales (Database, Audit).
 * AccountingModule es hoja: no importa SalesModule ni PaymentsModule —
 * ambos lo importan a él (PaymentsModule para que PaymentEngine componga
 * AccountingEngine; SalesModule para que SalesService lo haga
 * directamente), mismo patrón ya usado por InventoryModule con
 * StockMovementEngine. Sin forwardRef, sin ciclo: AccountingModule es el
 * ÚNICO propietario del provider AccountingEngine — ningún otro módulo lo
 * registra manualmente en su propio `providers`.
 *
 * Fase 8, Bloque C: agrega la superficie HTTP de solo lectura
 * (AccountingService + sus dos controllers). Sigue exportando únicamente
 * AccountingEngine — AccountingService es de uso interno del módulo, no se
 * exporta (ningún otro módulo necesita leer contabilidad).
 */
@Module({
  controllers: [AccountsController, AccountingEntriesController],
  providers: [AccountingEngine, AccountingService],
  exports: [AccountingEngine],
})
export class AccountingModule {}

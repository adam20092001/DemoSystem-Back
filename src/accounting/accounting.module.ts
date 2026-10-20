import { Module } from '@nestjs/common';
import { AccountingEngine } from './accounting.engine';
import { AccountingEntriesController } from './accounting-entries.controller';
import { AccountingPeriodsController } from './accounting-periods.controller';
import { AccountingPeriodsService } from './accounting-periods.service';
import { AccountingService } from './accounting.service';
import { AccountsController } from './accounts.controller';
import { ChartOfAccountsController } from './chart-of-accounts.controller';
import { ChartOfAccountsService } from './chart-of-accounts.service';

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
 *
 * Fase A1 (PCGE): agrega ChartOfAccountsController/Service, el recurso
 * NUEVO y separado de administración del plan de cuentas jerárquico.
 * Nunca se exporta: ningún otro módulo necesita administrar cuentas, y
 * AccountingEngine sigue siendo el único lector de Account.systemKey para
 * resolver asientos — sin cambios en esta fase.
 *
 * Fase A2 (periodos contables): agrega AccountingPeriodsController/Service,
 * el recurso de administración EXPLÍCITA del ciclo de vida OPEN/CLOSED.
 * Tampoco se exporta: ningún otro módulo administra periodos directamente
 * — SalesService/PaymentEngine siguen componiendo únicamente
 * AccountingEngine, que resuelve el periodo internamente.
 */
@Module({
  controllers: [
    AccountsController,
    AccountingEntriesController,
    ChartOfAccountsController,
    AccountingPeriodsController,
  ],
  providers: [
    AccountingEngine,
    AccountingService,
    ChartOfAccountsService,
    AccountingPeriodsService,
  ],
  exports: [AccountingEngine],
})
export class AccountingModule {}

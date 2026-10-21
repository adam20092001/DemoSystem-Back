import { Module } from '@nestjs/common';
import { ExcelExportService } from '../common/excel/excel-export.service';
import { AccountingEngine } from './accounting.engine';
import { AccountingEntriesController } from './accounting-entries.controller';
import { AccountingPeriodsController } from './accounting-periods.controller';
import { AccountingPeriodsService } from './accounting-periods.service';
import { AccountingReportsController } from './accounting-reports.controller';
import { AccountingReportsService } from './accounting-reports.service';
import { AccountingService } from './accounting.service';
import { AccountsController } from './accounts.controller';
import { ChartOfAccountsController } from './chart-of-accounts.controller';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { ManualJournalEntriesController } from './manual-journal-entries.controller';
import { ManualJournalEntriesService } from './manual-journal-entries.service';

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
 *
 * Fase A3 (reportes contables): agrega AccountingReportsController/Service
 * — Libro Diario, Libro Mayor y Balance de comprobación, de SOLO LECTURA.
 * Reutiliza ExcelExportService (mismo patrón ya usado por Sales/Quotes/
 * Products/AccountsReceivable, provider local sin dependencias). Nunca
 * escribe AccountingEntry/AccountingEntryLine ni invoca a AccountingEngine
 * para postear: deriva exclusivamente de lo ya persistido.
 *
 * Fase A4 (asientos manuales + rol ACCOUNTANT): agrega
 * ManualJournalEntriesController/Service — ciclo de vida DRAFT -> POSTED
 * de borradores de asiento manual y su reversión controlada.
 * ManualJournalEntriesService NUNCA escribe AccountingEntry/
 * AccountingEntryLine directamente: todo posteo/reversión definitivo pasa
 * por AccountingEngine (postManualEntry()/reverseOriginalForSource()),
 * que sigue siendo el único escritor de esas dos tablas. Tampoco se
 * exporta: ningún otro módulo administra borradores manuales.
 */
@Module({
  controllers: [
    AccountsController,
    AccountingEntriesController,
    ChartOfAccountsController,
    AccountingPeriodsController,
    AccountingReportsController,
    ManualJournalEntriesController,
  ],
  providers: [
    AccountingEngine,
    AccountingService,
    ChartOfAccountsService,
    AccountingPeriodsService,
    AccountingReportsService,
    ExcelExportService,
    ManualJournalEntriesService,
  ],
  exports: [AccountingEngine],
})
export class AccountingModule {}

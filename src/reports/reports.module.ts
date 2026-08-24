import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * PrismaService llega del módulo global Database. ReportsModule es hoja:
 * no importa SalesModule/PaymentsModule/QuotesModule/InventoryModule/
 * AccountingModule/CustomersModule ni inyecta ninguno de sus engines —
 * ReportsService/DashboardService consultan las tablas subyacentes
 * directamente vía PrismaService (Fase 9, Bloques B y C). El Dashboard
 * (GET /dashboard) vive dentro de este mismo módulo en vez de un
 * DashboardModule separado: comparte el mismo criterio arquitectónico
 * (lectura directa, sin engines) y no hay un segundo caso de uso que
 * justifique separarlo (CLAUDE.md §3: sin sobreingeniería). Nada se
 * exporta: ningún otro módulo necesita consumir reportes ni el Dashboard.
 */
@Module({
  controllers: [ReportsController, DashboardController],
  providers: [ReportsService, DashboardService],
})
export class ReportsModule {}

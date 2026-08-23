import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * PrismaService llega del módulo global Database. ReportsModule es hoja:
 * no importa SalesModule/PaymentsModule/QuotesModule/InventoryModule/
 * AccountingModule/CustomersModule ni inyecta ninguno de sus engines —
 * ReportsService consulta las tablas subyacentes directamente vía
 * PrismaService (Fase 9, Bloque B). Nada se exporta: ningún otro módulo
 * necesita consumir reportes.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}

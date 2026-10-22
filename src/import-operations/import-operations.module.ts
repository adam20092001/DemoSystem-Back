import { Module } from '@nestjs/common';
import { ImportOperationsController } from './import-operations.controller';
import { ImportOperationsService } from './import-operations.service';
import { ImportShipmentsController } from './import-shipments.controller';
import { ImportShipmentsService } from './import-shipments.service';

/**
 * PrismaService y AuditService llegan de módulos globales (Database,
 * Audit). Un solo módulo para ambos agregados (ImportOperation/
 * ImportShipment), mismo criterio de simplicidad que otros dominios de una
 * sola fase sin consumidores externos todavía (Fase B1) — a diferencia de
 * PurchaseInvoices/PurchaseReceipts, que son módulos separados porque
 * PurchaseReceiptsModule necesita inyectar StockMovementEngine/
 * InventoryValuationEngine (B1 nunca inyecta ninguno de los dos: ver
 * CLAUDE.md B1 §4, separación crítica).
 */
@Module({
  controllers: [ImportOperationsController, ImportShipmentsController],
  providers: [ImportOperationsService, ImportShipmentsService],
  exports: [ImportOperationsService, ImportShipmentsService],
})
export class ImportOperationsModule {}

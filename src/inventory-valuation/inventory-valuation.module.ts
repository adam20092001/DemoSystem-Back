import { Module } from '@nestjs/common';
import { InventoryValuationController } from './inventory-valuation.controller';
import { InventoryValuationEngine } from './inventory-valuation.engine';
import { InventoryValuationService } from './inventory-valuation.service';

/**
 * PrismaService/AuditService llegan de módulos globales (Database,
 * Audit). Hoja en el grafo de dependencias salvo por
 * InventoryValuationEngine, que PurchaseReceiptsModule importa y
 * reutiliza dentro de su propia transacción (mismo patrón ya usado por
 * InventoryModule con StockMovementEngine).
 */
@Module({
  controllers: [InventoryValuationController],
  providers: [InventoryValuationService, InventoryValuationEngine],
  exports: [InventoryValuationEngine],
})
export class InventoryValuationModule {}

import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { StockMovementEngine } from './stock-movement.engine';

/**
 * PrismaService y AuditService llegan de módulos globales (Database, Audit).
 * StockMovementEngine se exporta para que la futura Fase de Ventas pueda
 * reutilizarlo dentro de su propia transacción, sin pasar por
 * InventoryController.
 */
@Module({
  controllers: [InventoryController],
  providers: [InventoryService, StockMovementEngine],
  exports: [StockMovementEngine],
})
export class InventoryModule {}

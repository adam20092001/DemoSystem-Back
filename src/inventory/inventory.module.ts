import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { StockMovementEngine } from './stock-movement.engine';
import { StockTransfersController } from './transfers/stock-transfers.controller';
import { StockTransfersService } from './transfers/stock-transfers.service';

/**
 * PrismaService y AuditService llegan de módulos globales (Database, Audit).
 * StockMovementEngine se exporta para que la futura Fase de Ventas pueda
 * reutilizarlo dentro de su propia transacción, sin pasar por
 * InventoryController.
 */
@Module({
  controllers: [InventoryController, StockTransfersController],
  providers: [InventoryService, StockMovementEngine, StockTransfersService],
  exports: [StockMovementEngine],
})
export class InventoryModule {}

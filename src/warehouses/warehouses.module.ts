import { Module } from '@nestjs/common';
import { WarehouseLocationsService } from './warehouse-locations.service';
import { WarehousesController } from './warehouses.controller';
import { WarehousesService } from './warehouses.service';

/**
 * Catálogo de almacenes y ubicaciones (R2-A1, EXPAND). PrismaService y
 * AuditService llegan de módulos globales (Database, Audit). No se exporta
 * nada: ningún otro módulo consume este catálogo todavía (StockMovementEngine,
 * ventas y recepciones permanecen sin cambios hasta R2-ACT).
 */
@Module({
  controllers: [WarehousesController],
  providers: [WarehousesService, WarehouseLocationsService],
})
export class WarehousesModule {}

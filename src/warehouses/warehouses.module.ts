import { Module } from '@nestjs/common';
import { WarehouseLocationsService } from './warehouse-locations.service';
import { WarehousesController } from './warehouses.controller';
import { WarehousesService } from './warehouses.service';

/**
 * Catálogo de almacenes y ubicaciones (R2-A1, EXPAND). PrismaService y
 * AuditService llegan de módulos globales (Database, Audit). No se exporta
 * nada: ningún otro módulo consume este catálogo vía el módulo (R2-ACT:
 * StockMovementEngine consulta las tablas directamente, sin importar este
 * módulo; la selección de ubicación en operaciones es R2-B).
 */
@Module({
  controllers: [WarehousesController],
  providers: [WarehousesService, WarehouseLocationsService],
})
export class WarehousesModule {}

import { Module } from '@nestjs/common';
import { DocumentSequencesModule } from '../document-sequences/document-sequences.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SaleDocumentRenderer } from './printing/sale-document.renderer';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

/**
 * PrismaService y AuditService llegan de módulos globales (Database, Audit).
 * SalesService (Bloque B) inyecta DocumentSequenceService (secuencia NV) y
 * StockMovementEngine (descuento/reversa de stock), así que solo se
 * importan DocumentSequencesModule e InventoryModule — los módulos que
 * realmente proveen esas dependencias. NO se importa QuotesModule: la
 * conversión de cotización a venta vive por completo dentro de la propia
 * transacción de SalesService, usando Prisma directamente y las funciones
 * puras de quote-calculator.ts (effectiveStatus), nunca QuotesService (D17
 * del plan aprobado: SalesService posee la conversión, sin dependencia de
 * inyección hacia Quotes).
 */
@Module({
  imports: [DocumentSequencesModule, InventoryModule],
  controllers: [SalesController],
  providers: [SalesService, SaleDocumentRenderer],
  exports: [SalesService],
})
export class SalesModule {}

import { Module } from '@nestjs/common';
import { DocumentSequencesModule } from '../document-sequences/document-sequences.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentsModule } from '../payments/payments.module';
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
 *
 * PaymentEngine (Fase 7) se importa desde PaymentsModule (Bloque C), que lo
 * exporta — mismo patrón ya usado para StockMovementEngine vía
 * InventoryModule. Reemplaza el registro temporal directo en
 * `providers: [..., PaymentEngine]` del Bloque B (cuando PaymentsModule
 * todavía no existía): ahora PaymentsModule es el ÚNICO propietario del
 * provider, sin duplicación. PaymentsModule NUNCA importa SalesModule, así
 * que no hay ciclo y no hace falta forwardRef.
 */
@Module({
  imports: [DocumentSequencesModule, InventoryModule, PaymentsModule],
  controllers: [SalesController],
  providers: [SalesService, SaleDocumentRenderer],
  exports: [SalesService],
})
export class SalesModule {}

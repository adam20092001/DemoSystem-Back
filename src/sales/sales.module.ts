import { Module } from '@nestjs/common';
import { DocumentSequencesModule } from '../document-sequences/document-sequences.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentEngine } from '../payments/payment.engine';
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
 * PaymentEngine (Fase 7, Bloque B) se declara aquí como provider directo,
 * NO importado desde un PaymentsModule (que no existe todavía — Bloque C):
 * PaymentEngine solo depende de AuditService (global), así que registrarlo
 * localmente es autosuficiente y evita crear un módulo entero solo para
 * exponer un provider. Cuando el Bloque C introduzca PaymentsModule, este
 * import se reemplazará por `imports: [..., PaymentsModule]` con
 * PaymentsModule exportando PaymentEngine (mismo patrón ya usado para
 * StockMovementEngine vía InventoryModule) — SalesModule seguirá sin
 * importar PaymentsModule -> SalesModule en sentido inverso.
 */
@Module({
  imports: [DocumentSequencesModule, InventoryModule],
  controllers: [SalesController],
  providers: [SalesService, SaleDocumentRenderer, PaymentEngine],
  exports: [SalesService],
})
export class SalesModule {}

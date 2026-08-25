import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { ConfigurationModule } from '../configuration/configuration.module';
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
 *
 * Desde la Fase 8, Bloque B: importa AccountingModule para que SalesService
 * componga AccountingEngine DIRECTAMENTE dentro de su propia transacción
 * (reconocimiento de venta al confirmar, reversión al anular) — el pago
 * inicial sigue posteando su propio asiento de cobro a través de
 * PaymentEngine, nunca duplicado aquí. AccountingModule es hoja (no importa
 * SalesModule ni PaymentsModule), así que importarlo desde ambos módulos no
 * genera ciclo ni requiere forwardRef. AccountingEngine NUNCA se registra
 * manualmente en `providers`: AccountingModule es su único propietario.
 *
 * Desde la Fase 10, Bloque B: importa ConfigurationModule para que
 * SalesService inyecte únicamente SettingsReader (descuento máximo
 * configurado en la venta DIRECTA) — nunca ConfigurationService/
 * ConfigurationController. La conversión de cotización a venta NUNCA usa
 * SettingsReader para el descuento (D18 aprobado: copia exacta del
 * snapshot de la cotización, sin revalidar contra la configuración
 * vigente). Sin ciclo: ConfigurationModule nunca importa SalesModule.
 */
@Module({
  imports: [
    DocumentSequencesModule,
    InventoryModule,
    PaymentsModule,
    AccountingModule,
    ConfigurationModule,
  ],
  controllers: [SalesController],
  providers: [SalesService, SaleDocumentRenderer],
  exports: [SalesService],
})
export class SalesModule {}

import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { PurchaseInvoicesController } from './purchase-invoices.controller';
import { PurchaseInvoicesService } from './purchase-invoices.service';

/**
 * PrismaService/AuditService llegan de módulos globales (Database, Audit).
 * AccountingModule se importa para componer AccountingEngine
 * (postPurchaseRecognition()/reverseOriginalForSource()) — mismo patrón ya
 * usado por SalesModule/PaymentsModule/ManualJournalEntriesService (A4):
 * PurchaseInvoicesService nunca escribe AccountingEntry/AccountingEntryLine
 * directamente. ConfigurationModule se importa únicamente por SettingsReader
 * (snapshot de currencyCode/taxEnabled/taxRate al crear/editar una línea).
 * Validación de supplierId se hace vía Prisma directo (Supplier.status),
 * sin importar SuppliersModule: no se necesita ninguna regla de negocio de
 * SuppliersService, solo existencia + estado, igual criterio que
 * ProductsModule no se importa para validar productId. Hoja: no se exporta
 * — A5.2b (todavía no implementada) decidirá en su momento si necesita
 * consumir este servicio.
 */
@Module({
  imports: [AccountingModule, ConfigurationModule],
  controllers: [PurchaseInvoicesController],
  providers: [PurchaseInvoicesService],
})
export class PurchaseInvoicesModule {}

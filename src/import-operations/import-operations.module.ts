import { Module } from '@nestjs/common';
import { ExcelExportService } from '../common/excel/excel-export.service';
import { ConfigurationModule } from '../configuration/configuration.module';
import {
  ImportExpensesController,
  ImportOperationExpensesController,
} from './import-expenses.controller';
import { ImportExpensesService } from './import-expenses.service';
import { ImportOperationsController } from './import-operations.controller';
import { ImportOperationsService } from './import-operations.service';
import {
  ImportExpenseAllocationCostPreviewController,
  ImportReceiptLinksController,
  ImportShipmentLineReceiptLinksController,
} from './import-receipt-links.controller';
import { ImportReceiptLinksService } from './import-receipt-links.service';
import { ImportReportsController } from './import-reports.controller';
import { ImportReportsService } from './import-reports.service';
import { ImportShipmentsController } from './import-shipments.controller';
import { ImportShipmentsService } from './import-shipments.service';

/**
 * PrismaService y AuditService llegan de módulos globales (Database,
 * Audit). Un solo módulo para todos los agregados de Importaciones
 * (ImportOperation/ImportShipment/ImportExpense/ImportReceiptLink), mismo
 * criterio de simplicidad que otros dominios sin consumidores externos
 * todavía — a diferencia de PurchaseInvoices/PurchaseReceipts, que son
 * módulos separados porque PurchaseReceiptsModule necesita inyectar
 * StockMovementEngine/InventoryValuationEngine (B1-B3 nunca inyectan
 * ninguno de los dos: ver CLAUDE.md B1 §4/B3 §1/§6, separación crítica).
 * ConfigurationModule se importa únicamente por SettingsReader (Fase B3:
 * ImportReceiptLinksService.previewCostAttribution() lo usa para comparar
 * la moneda del gasto contra la de la empresa, nunca para convertir).
 *
 * Fase B4 (reportes y reconciliación): agrega ImportReportsController/
 * Service, de SOLO LECTURA — nunca escribe ninguna tabla, nunca activa
 * capitalización/FX/mapeos contables. Reutiliza ExcelExportService (mismo
 * patrón que AccountingModule) y `computeCostAttributionSplit` (B3) para
 * nunca reimplementar el cálculo de atribución de costo.
 */
@Module({
  imports: [ConfigurationModule],
  controllers: [
    ImportOperationsController,
    ImportShipmentsController,
    ImportOperationExpensesController,
    ImportExpensesController,
    ImportShipmentLineReceiptLinksController,
    ImportReceiptLinksController,
    ImportExpenseAllocationCostPreviewController,
    ImportReportsController,
  ],
  providers: [
    ImportOperationsService,
    ImportShipmentsService,
    ImportExpensesService,
    ImportReceiptLinksService,
    ImportReportsService,
    ExcelExportService,
  ],
  exports: [
    ImportOperationsService,
    ImportShipmentsService,
    ImportExpensesService,
    ImportReceiptLinksService,
  ],
})
export class ImportOperationsModule {}

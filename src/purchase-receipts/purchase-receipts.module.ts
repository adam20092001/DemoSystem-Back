import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { InventoryModule } from '../inventory/inventory.module';
import { InventoryValuationModule } from '../inventory-valuation/inventory-valuation.module';
import {
  PurchaseInvoiceReceiptsController,
  PurchaseReceiptsController,
} from './purchase-receipts.controller';
import { PurchaseReceiptsService } from './purchase-receipts.service';

/**
 * PrismaService/AuditService llegan de módulos globales (Database, Audit).
 * AccountingModule se importa por AccountingEngine (reclasificación
 * contable opcional); InventoryModule por StockMovementEngine (único
 * escritor de InventoryMovement/Product.stockCurrent) — mismo patrón que
 * PurchaseInvoicesModule/SalesModule. InventoryValuationModule (Fase A6.1)
 * por InventoryValuationEngine (valorización opcional, por producto,
 * nunca activada por defecto) — mismo criterio exacto que AccountingModule
 * aquí: una capa adicional, siempre dentro de la MISMA transacción que ya
 * abre PurchaseReceiptsService, nunca un segundo escritor de inventario
 * físico. Hoja: no se exporta.
 */
@Module({
  imports: [AccountingModule, InventoryModule, InventoryValuationModule],
  controllers: [PurchaseInvoiceReceiptsController, PurchaseReceiptsController],
  providers: [PurchaseReceiptsService],
})
export class PurchaseReceiptsModule {}

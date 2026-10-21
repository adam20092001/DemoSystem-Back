import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { InventoryModule } from '../inventory/inventory.module';
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
 * PurchaseInvoicesModule/SalesModule. Hoja: no se exporta.
 */
@Module({
  imports: [AccountingModule, InventoryModule],
  controllers: [PurchaseInvoiceReceiptsController, PurchaseReceiptsController],
  providers: [PurchaseReceiptsService],
})
export class PurchaseReceiptsModule {}

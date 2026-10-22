import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccountingModule } from './accounting/accounting.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CategoriesModule } from './categories/categories.module';
import { validateEnv } from './config/env.validation';
import { ConfigurationModule } from './configuration/configuration.module';
import { CustomersModule } from './customers/customers.module';
import { DatabaseModule } from './database/database.module';
import { ElectronicInvoicingModule } from './electronic-invoicing/electronic-invoicing.module';
import { HealthModule } from './health/health.module';
import { ImportOperationsModule } from './import-operations/import-operations.module';
import { InventoryModule } from './inventory/inventory.module';
import { InventoryValuationModule } from './inventory-valuation/inventory-valuation.module';
import { PaymentMethodsModule } from './payment-methods/payment-methods.module';
import { PaymentsModule } from './payments/payments.module';
import { ProductsModule } from './products/products.module';
import { PurchaseInvoicesModule } from './purchase-invoices/purchase-invoices.module';
import { PurchaseReceiptsModule } from './purchase-receipts/purchase-receipts.module';
import { QuotesModule } from './quotes/quotes.module';
import { ReportsModule } from './reports/reports.module';
import { SalesModule } from './sales/sales.module';
import { SupplierPaymentsModule } from './supplier-payments/supplier-payments.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { UnitsModule } from './units/units.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: '.env',
      validate: validateEnv,
    }),
    DatabaseModule,
    AuditModule,
    UsersModule,
    AuthModule,
    CategoriesModule,
    UnitsModule,
    ProductsModule,
    InventoryModule,
    InventoryValuationModule,
    CustomersModule,
    SuppliersModule,
    QuotesModule,
    SalesModule,
    PaymentMethodsModule,
    PaymentsModule,
    AccountingModule,
    PurchaseInvoicesModule,
    PurchaseReceiptsModule,
    SupplierPaymentsModule,
    ImportOperationsModule,
    ReportsModule,
    ConfigurationModule,
    ElectronicInvoicingModule,
    HealthModule,
  ],
})
export class AppModule {}

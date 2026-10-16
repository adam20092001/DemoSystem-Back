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
import { InventoryModule } from './inventory/inventory.module';
import { PaymentMethodsModule } from './payment-methods/payment-methods.module';
import { PaymentsModule } from './payments/payments.module';
import { ProductsModule } from './products/products.module';
import { QuotesModule } from './quotes/quotes.module';
import { ReportsModule } from './reports/reports.module';
import { SalesModule } from './sales/sales.module';
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
    CustomersModule,
    QuotesModule,
    SalesModule,
    PaymentMethodsModule,
    PaymentsModule,
    AccountingModule,
    ReportsModule,
    ConfigurationModule,
    ElectronicInvoicingModule,
    HealthModule,
  ],
})
export class AppModule {}

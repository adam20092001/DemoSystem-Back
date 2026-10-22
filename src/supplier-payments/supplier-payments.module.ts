import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { PaymentMethodsModule } from '../payment-methods/payment-methods.module';
import { AccountsPayableController } from './accounts-payable.controller';
import { AccountsPayableService } from './accounts-payable.service';
import { SupplierPaymentsController } from './supplier-payments.controller';
import { SupplierPaymentsService } from './supplier-payments.service';

/**
 * PrismaService/AuditService llegan de módulos globales (Database, Audit).
 * AccountingModule se importa por AccountingEngine (posteo/reversión del
 * cobro al proveedor); ConfigurationModule por SettingsReader (moneda
 * vigente); PaymentMethodsModule por PaymentMethodReader (resolución del
 * método de pago dinámico) — mismo patrón que PaymentsModule/
 * PurchaseInvoicesModule. Hoja: no se exporta.
 */
@Module({
  imports: [AccountingModule, ConfigurationModule, PaymentMethodsModule],
  controllers: [SupplierPaymentsController, AccountsPayableController],
  providers: [SupplierPaymentsService, AccountsPayableService],
})
export class SupplierPaymentsModule {}

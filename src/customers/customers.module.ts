import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

/**
 * PrismaService y AuditService llegan de módulos globales (Database, Audit).
 * Se exporta CustomersService porque las Fases 5-7 (Cotizaciones, Ventas,
 * Pagos) necesitarán consumir el dominio de Customer (p. ej. resolver el
 * genérico o convertir un prospecto), igual que ProductsModule/CategoriesModule.
 */
@Module({
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}

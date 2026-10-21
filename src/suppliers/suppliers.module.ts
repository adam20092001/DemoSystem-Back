import { Module } from '@nestjs/common';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

/**
 * PrismaService y AuditService llegan de módulos globales (Database, Audit).
 * Se exporta SuppliersService para que una futura Fase A5.2 (Compras) pueda
 * consumir el dominio de Supplier (p. ej. validar que un supplierId exista
 * y esté ACTIVE), igual que CustomersModule/ProductsModule hoy.
 */
@Module({
  controllers: [SuppliersController],
  providers: [SuppliersService],
  exports: [SuppliersService],
})
export class SuppliersModule {}

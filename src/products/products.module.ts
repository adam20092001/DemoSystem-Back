import { Module } from '@nestjs/common';
import { ProductSpecificationsService } from './product-specifications.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

/** PrismaService y AuditService llegan de módulos globales (Database, Audit). */
@Module({
  controllers: [ProductsController],
  providers: [ProductsService, ProductSpecificationsService],
  exports: [ProductsService, ProductSpecificationsService],
})
export class ProductsModule {}

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { EnvironmentVariables } from '../config/env.validation';
import { ProductImagesService } from './product-images.service';
import { ProductSpecificationsService } from './product-specifications.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { LocalDiskImageStorageService } from './storage/local-disk-image-storage.service';
import { IMAGE_STORAGE } from './storage/image-storage.token';

/** PrismaService y AuditService llegan de módulos globales (Database, Audit). */
@Module({
  imports: [
    // Almacenamiento en memoria: ProductImagesService valida el archivo
    // (MIME + firma binaria) antes de escribirlo en disco. El límite de
    // tamaño viene de PRODUCT_IMAGE_MAX_SIZE_BYTES, nunca hardcodeado.
    MulterModule.registerAsync({
      useFactory: (
        configService: ConfigService<EnvironmentVariables, true>,
      ) => ({
        storage: memoryStorage(),
        limits: {
          fileSize: configService.get('PRODUCT_IMAGE_MAX_SIZE_BYTES', {
            infer: true,
          }),
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [ProductsController],
  providers: [
    ProductsService,
    ProductSpecificationsService,
    ProductImagesService,
    { provide: IMAGE_STORAGE, useClass: LocalDiskImageStorageService },
  ],
  exports: [
    ProductsService,
    ProductSpecificationsService,
    ProductImagesService,
  ],
})
export class ProductsModule {}

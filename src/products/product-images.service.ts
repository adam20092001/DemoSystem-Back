import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProductStatus, RoleName } from '@prisma/client';
import { Readable } from 'node:stream';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { toSafeProductImage } from './mappers/product.mapper';
import type { ImageStorage } from './storage/image-storage.interface';
import { IMAGE_STORAGE } from './storage/image-storage.token';
import { AddProductImageInput } from './types/add-product-image.input';
import {
  GetProductImageFileInput,
  RemoveProductImageInput,
  SetPrimaryProductImageInput,
} from './types/product-image-action.input';
import { SafeProductImage } from './types/safe-product-image';
import {
  detectImageFormat,
  EXTENSION_BY_IMAGE_FORMAT,
  isAllowedImageMimeType,
} from './utils/detect-image-format';
import { sanitizeFileName } from './utils/sanitize-file-name';

const IMAGE_SELECT = {
  id: true,
  productId: true,
  fileName: true,
  storagePath: true,
  mimeType: true,
  fileSize: true,
  sortOrder: true,
  isPrimary: true,
  createdAt: true,
} satisfies Prisma.ProductImageSelect;

type ImageRow = Prisma.ProductImageGetPayload<{ select: typeof IMAGE_SELECT }>;

export interface ProductImageFile {
  stream: Readable;
  mimeType: string;
  fileSize: number;
  fileName: string;
}

/**
 * Vive dentro de ProductsModule, igual que ProductSpecificationsService: las
 * imágenes no tienen ciclo de vida propio fuera de un producto.
 */
@Injectable()
export class ProductImagesService {
  private readonly logger = new Logger(ProductImagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @Inject(IMAGE_STORAGE) private readonly imageStorage: ImageStorage,
  ) {}

  async addImage(input: AddProductImageInput): Promise<SafeProductImage> {
    const product = await this.prisma.product.findUnique({
      where: { id: input.productId },
      select: { id: true },
    });
    if (product === null) {
      throw new NotFoundException('Producto no encontrado');
    }

    if (!isAllowedImageMimeType(input.file.mimetype)) {
      throw new BadRequestException(
        'Formato de imagen no permitido: solo se aceptan image/jpeg, image/png o image/webp',
      );
    }

    const detectedFormat = detectImageFormat(input.file.buffer);
    if (detectedFormat === null || detectedFormat !== input.file.mimetype) {
      throw new BadRequestException(
        'El contenido del archivo no coincide con el tipo declarado',
      );
    }

    const fileName = sanitizeFileName(input.file.originalname);
    const extension = EXTENSION_BY_IMAGE_FORMAT[detectedFormat];

    const saved = await this.imageStorage.save({
      productId: input.productId,
      buffer: input.file.buffer,
      extension,
    });

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingImagesCount = await tx.productImage.count({
          where: { productId: input.productId },
        });
        const isPrimary = existingImagesCount === 0;

        const created = await tx.productImage.create({
          data: {
            productId: input.productId,
            fileName,
            storagePath: saved.storagePath,
            mimeType: detectedFormat,
            fileSize: input.file.buffer.length,
            sortOrder: input.sortOrder ?? 0,
            isPrimary,
          },
          select: IMAGE_SELECT,
        });

        await this.auditService.record({
          userId: input.actorUserId,
          module: 'PRODUCTS',
          action: AuditAction.PRODUCT_IMAGE_ADDED,
          entityType: 'Product',
          entityId: input.productId,
          description: 'Imagen agregada al producto',
          metadata: {
            imageId: created.id,
            mimeType: created.mimeType,
            fileSize: created.fileSize,
            isPrimary: created.isPrimary,
          },
          ipAddress: input.ipAddress ?? null,
          client: tx,
        });

        return toSafeProductImage(created, input.productId);
      });
    } catch (error) {
      await this.imageStorage.delete(saved.storagePath).catch(() => {
        this.logger.error(
          'No se pudo eliminar el archivo físico tras revertir la creación de una imagen de producto.',
        );
      });
      throw error;
    }
  }

  async setPrimaryImage(
    input: SetPrimaryProductImageInput,
  ): Promise<SafeProductImage> {
    return this.prisma.$transaction(async (tx) => {
      const image = await this.findOwnedImage(
        tx,
        input.productId,
        input.imageId,
      );
      if (image.isPrimary) {
        throw new ConflictException('La imagen ya es la principal');
      }

      const previousPrimary = await tx.productImage.findFirst({
        where: { productId: input.productId, isPrimary: true },
        select: { id: true },
      });

      await tx.productImage.updateMany({
        where: { productId: input.productId, isPrimary: true },
        data: { isPrimary: false },
      });

      const updated = await tx.productImage.update({
        where: { id: input.imageId },
        data: { isPrimary: true },
        select: IMAGE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PRODUCTS',
        action: AuditAction.PRODUCT_PRIMARY_IMAGE_CHANGED,
        entityType: 'Product',
        entityId: input.productId,
        description: 'Imagen principal del producto cambiada',
        metadata: {
          previousImageId: previousPrimary?.id ?? null,
          newImageId: updated.id,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeProductImage(updated, input.productId);
    });
  }

  async removeImage(input: RemoveProductImageInput): Promise<void> {
    const { storagePath } = await this.prisma.$transaction(async (tx) => {
      const image = await this.findOwnedImage(
        tx,
        input.productId,
        input.imageId,
      );

      await tx.productImage.delete({ where: { id: input.imageId } });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PRODUCTS',
        action: AuditAction.PRODUCT_IMAGE_REMOVED,
        entityType: 'Product',
        entityId: input.productId,
        description: 'Imagen eliminada del producto',
        metadata: { imageId: image.id, wasPrimary: image.isPrimary },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      if (image.isPrimary) {
        const next = await tx.productImage.findFirst({
          where: { productId: input.productId },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: { id: true },
        });
        if (next !== null) {
          await tx.productImage.update({
            where: { id: next.id },
            data: { isPrimary: true },
          });

          await this.auditService.record({
            userId: input.actorUserId,
            module: 'PRODUCTS',
            action: AuditAction.PRODUCT_PRIMARY_IMAGE_CHANGED,
            entityType: 'Product',
            entityId: input.productId,
            description:
              'Imagen principal del producto reasignada tras eliminación',
            metadata: { previousImageId: image.id, newImageId: next.id },
            ipAddress: input.ipAddress ?? null,
            client: tx,
          });
        }
      }

      return { storagePath: image.storagePath };
    });

    try {
      await this.imageStorage.delete(storagePath);
    } catch {
      // La fila ya fue confirmada: un fallo físico aquí no revierte la
      // eliminación ni convierte una respuesta 204 en un error. Se deja
      // constancia sin incluir la ruta física en el log.
      this.logger.error(
        'No se pudo eliminar el archivo físico de una imagen ya eliminada de la base de datos.',
      );
    }
  }

  /**
   * SELLER solo puede descargar imágenes de productos ACTIVE (mismo criterio
   * que listado/detalle de productos): un producto INACTIVE responde 404,
   * igual que si no existiera.
   */
  async openImageFile(
    input: GetProductImageFileInput,
    requesterRole: RoleName,
  ): Promise<ProductImageFile> {
    const product = await this.prisma.product.findUnique({
      where: { id: input.productId },
      select: { id: true, status: true },
    });
    if (product === null) {
      throw new NotFoundException('Producto no encontrado');
    }
    if (
      requesterRole === RoleName.SELLER &&
      product.status !== ProductStatus.ACTIVE
    ) {
      throw new NotFoundException('Producto no encontrado');
    }

    const image = await this.prisma.productImage.findUnique({
      where: { id: input.imageId },
      select: IMAGE_SELECT,
    });
    if (image === null || image.productId !== input.productId) {
      throw new NotFoundException('Imagen no encontrada');
    }

    const exists = await this.imageStorage.exists(image.storagePath);
    if (!exists) {
      throw new NotFoundException('Imagen no encontrada');
    }

    return {
      stream: this.imageStorage.createReadStream(image.storagePath),
      mimeType: image.mimeType,
      fileSize: image.fileSize,
      fileName: image.fileName,
    };
  }

  /**
   * Verifica que la imagen exista y pertenezca al producto de la ruta. No
   * confía en que imageId por sí solo sea suficiente (evita leak de
   * existencia cruzada entre productos).
   */
  private async findOwnedImage(
    tx: Prisma.TransactionClient,
    productId: string,
    imageId: string,
  ): Promise<ImageRow> {
    const image = await tx.productImage.findUnique({
      where: { id: imageId },
      select: IMAGE_SELECT,
    });
    if (image === null || image.productId !== productId) {
      throw new NotFoundException('Imagen no encontrada');
    }
    return image;
  }
}

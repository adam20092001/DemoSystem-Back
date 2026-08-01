import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ProductStatus, RoleName } from '@prisma/client';
import { Readable } from 'node:stream';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ProductImagesService } from './product-images.service';
import { ImageStorage } from './storage/image-storage.interface';

const ACTOR_ID = 'actor-id';
const NOW = new Date('2026-01-01T00:00:00.000Z');

const VALID_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const VALID_WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP'),
  Buffer.from([0, 0, 0, 0]),
]);
const INVALID_SIGNATURE = Buffer.from('esto no es una imagen real');

interface ImageFindUniqueArgs {
  where: { id: string };
}
interface ImageCreateArgs {
  data: Record<string, unknown>;
}
interface ImageUpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}
interface ImageUpdateManyArgs {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}
interface ImageFindFirstArgs {
  where?: Record<string, unknown>;
  orderBy?: unknown;
}
interface ImageCountArgs {
  where?: Record<string, unknown>;
}
interface ImageDeleteArgs {
  where: { id: string };
}
interface ProductFindUniqueArgs {
  where: { id: string };
}

function makeImageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'image-1',
    productId: 'product-1',
    fileName: 'foto.jpg',
    storagePath: 'product-1/uuid-1.jpg',
    mimeType: 'image/jpeg',
    fileSize: VALID_JPEG.length,
    sortOrder: 0,
    isPrimary: false,
    createdAt: NOW,
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    productImage: {
      count: jest.fn<Promise<number>, [ImageCountArgs?]>(),
      create: jest.fn<Promise<unknown>, [ImageCreateArgs]>(),
      findUnique: jest.fn<Promise<unknown>, [ImageFindUniqueArgs]>(),
      findFirst: jest.fn<Promise<unknown>, [ImageFindFirstArgs?]>(),
      update: jest.fn<Promise<unknown>, [ImageUpdateArgs]>(),
      updateMany: jest.fn<Promise<unknown>, [ImageUpdateManyArgs]>(),
      delete: jest.fn<Promise<unknown>, [ImageDeleteArgs]>(),
    },
  };

  return {
    tx,
    product: {
      findUnique: jest.fn<Promise<unknown>, [ProductFindUniqueArgs]>(),
    },
    productImage: {
      findUnique: jest.fn<Promise<unknown>, [ImageFindUniqueArgs]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createAuditServiceMock() {
  return {
    record: jest.fn<Promise<void>, [Record<string, unknown>]>(),
  };
}

function createImageStorageMock() {
  return {
    save: jest.fn<
      ReturnType<ImageStorage['save']>,
      Parameters<ImageStorage['save']>
    >(),
    delete: jest.fn<
      ReturnType<ImageStorage['delete']>,
      Parameters<ImageStorage['delete']>
    >(),
    createReadStream: jest.fn<
      ReturnType<ImageStorage['createReadStream']>,
      Parameters<ImageStorage['createReadStream']>
    >(),
    exists: jest.fn<
      ReturnType<ImageStorage['exists']>,
      Parameters<ImageStorage['exists']>
    >(),
  };
}

describe('ProductImagesService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let imageStorage: ReturnType<typeof createImageStorageMock>;
  let service: ProductImagesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    imageStorage = createImageStorageMock();
    auditService.record.mockResolvedValue(undefined);
    imageStorage.delete.mockResolvedValue(undefined);

    service = new ProductImagesService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
      imageStorage,
    );
  });

  describe('addImage', () => {
    const validInput = {
      productId: 'product-1',
      file: {
        buffer: VALID_JPEG,
        mimetype: 'image/jpeg',
        originalname: 'mi foto.jpg',
        size: VALID_JPEG.length,
      },
      actorUserId: ACTOR_ID,
      ipAddress: '10.0.0.1',
    };

    beforeEach(() => {
      prisma.product.findUnique.mockResolvedValue({ id: 'product-1' });
      imageStorage.save.mockResolvedValue({
        storagePath: 'product-1/uuid-1.jpg',
      });
    });

    it('acepta un archivo JPEG válido y devuelve la forma segura', async () => {
      prisma.tx.productImage.count.mockResolvedValue(0);
      prisma.tx.productImage.create.mockResolvedValue(makeImageRow());

      const result = await service.addImage(validInput);

      expect(result.id).toBe('image-1');
      expect(result).not.toHaveProperty('storagePath');
    });

    it('acepta un archivo PNG válido', async () => {
      prisma.tx.productImage.count.mockResolvedValue(0);
      prisma.tx.productImage.create.mockResolvedValue(
        makeImageRow({ mimeType: 'image/png' }),
      );

      await expect(
        service.addImage({
          ...validInput,
          file: {
            ...validInput.file,
            buffer: VALID_PNG,
            mimetype: 'image/png',
          },
        }),
      ).resolves.toBeDefined();
    });

    it('acepta un archivo WebP válido', async () => {
      prisma.tx.productImage.count.mockResolvedValue(0);
      prisma.tx.productImage.create.mockResolvedValue(
        makeImageRow({ mimeType: 'image/webp' }),
      );

      await expect(
        service.addImage({
          ...validInput,
          file: {
            ...validInput.file,
            buffer: VALID_WEBP,
            mimetype: 'image/webp',
          },
        }),
      ).resolves.toBeDefined();
    });

    it('lanza NotFoundException si el producto no existe', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(service.addImage(validInput)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(imageStorage.save).not.toHaveBeenCalled();
    });

    it('rechaza un MIME no permitido antes de guardar el archivo', async () => {
      await expect(
        service.addImage({
          ...validInput,
          file: { ...validInput.file, mimetype: 'image/gif' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(imageStorage.save).not.toHaveBeenCalled();
    });

    it('rechaza cuando la firma binaria no coincide con ningún formato permitido', async () => {
      await expect(
        service.addImage({
          ...validInput,
          file: { ...validInput.file, buffer: INVALID_SIGNATURE },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(imageStorage.save).not.toHaveBeenCalled();
    });

    it('rechaza cuando el MIME declarado no coincide con la firma detectada', async () => {
      await expect(
        service.addImage({
          ...validInput,
          file: {
            ...validInput.file,
            buffer: VALID_PNG,
            mimetype: 'image/jpeg',
          },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(imageStorage.save).not.toHaveBeenCalled();
    });

    it('la primera imagen del producto se crea como principal', async () => {
      prisma.tx.productImage.count.mockResolvedValue(0);
      prisma.tx.productImage.create.mockResolvedValue(
        makeImageRow({ isPrimary: true }),
      );

      const result = await service.addImage(validInput);

      expect(result.isPrimary).toBe(true);
      const createArgs = prisma.tx.productImage.create.mock.calls[0][0];
      expect(createArgs.data.isPrimary).toBe(true);
    });

    it('la segunda imagen del producto no se crea como principal', async () => {
      prisma.tx.productImage.count.mockResolvedValue(1);
      prisma.tx.productImage.create.mockResolvedValue(
        makeImageRow({ isPrimary: false }),
      );

      const result = await service.addImage(validInput);

      expect(result.isPrimary).toBe(false);
      const createArgs = prisma.tx.productImage.create.mock.calls[0][0];
      expect(createArgs.data.isPrimary).toBe(false);
    });

    it('genera la extensión desde el contenido detectado, no desde el nombre original', async () => {
      prisma.tx.productImage.count.mockResolvedValue(0);
      prisma.tx.productImage.create.mockResolvedValue(makeImageRow());

      await service.addImage({
        ...validInput,
        file: { ...validInput.file, originalname: 'archivo.png' },
      });

      const saveArgs = imageStorage.save.mock.calls[0][0];
      expect(saveArgs.extension).toBe('jpg');
    });

    it('registra PRODUCT_IMAGE_ADDED sin storagePath en la metadata', async () => {
      prisma.tx.productImage.count.mockResolvedValue(0);
      prisma.tx.productImage.create.mockResolvedValue(makeImageRow());

      await service.addImage(validInput);

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PRODUCT_IMAGE_ADDED,
          client: prisma.tx,
          metadata: {
            imageId: 'image-1',
            mimeType: 'image/jpeg',
            fileSize: expect.any(Number) as number,
            isPrimary: false,
          },
        }),
      );
      const auditArgs = auditService.record.mock.calls[0][0];
      expect(JSON.stringify(auditArgs)).not.toContain('storagePath');
    });

    it('si la transacción falla después de guardar el archivo, elimina el archivo físico y propaga el error', async () => {
      prisma.tx.productImage.count.mockResolvedValue(0);
      prisma.tx.productImage.create.mockRejectedValue(
        new Error('fallo simulado de base de datos'),
      );

      await expect(service.addImage(validInput)).rejects.toThrow(
        'fallo simulado de base de datos',
      );

      expect(imageStorage.delete).toHaveBeenCalledWith('product-1/uuid-1.jpg');
    });

    it('si la auditoría falla, revierte la escritura de BD y también elimina el archivo físico', async () => {
      prisma.tx.productImage.count.mockResolvedValue(0);
      prisma.tx.productImage.create.mockResolvedValue(makeImageRow());
      auditService.record.mockRejectedValue(new Error('fallo de auditoría'));

      await expect(service.addImage(validInput)).rejects.toThrow(
        'fallo de auditoría',
      );
      expect(imageStorage.delete).toHaveBeenCalledWith('product-1/uuid-1.jpg');
    });
  });

  describe('setPrimaryImage', () => {
    it('establece la imagen como principal y registra PRODUCT_PRIMARY_IMAGE_CHANGED', async () => {
      prisma.tx.productImage.findUnique.mockResolvedValue(
        makeImageRow({ id: 'image-2', isPrimary: false }),
      );
      prisma.tx.productImage.findFirst.mockResolvedValue({ id: 'image-1' });
      prisma.tx.productImage.update.mockResolvedValue(
        makeImageRow({ id: 'image-2', isPrimary: true }),
      );

      const result = await service.setPrimaryImage({
        productId: 'product-1',
        imageId: 'image-2',
        actorUserId: ACTOR_ID,
      });

      expect(result.isPrimary).toBe(true);
      expect(prisma.tx.productImage.updateMany).toHaveBeenCalledWith({
        where: { productId: 'product-1', isPrimary: true },
        data: { isPrimary: false },
      });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PRODUCT_PRIMARY_IMAGE_CHANGED,
          metadata: { previousImageId: 'image-1', newImageId: 'image-2' },
        }),
      );
    });

    it('lanza ConflictException si la imagen ya es la principal', async () => {
      prisma.tx.productImage.findUnique.mockResolvedValue(
        makeImageRow({ isPrimary: true }),
      );

      await expect(
        service.setPrimaryImage({
          productId: 'product-1',
          imageId: 'image-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.productImage.updateMany).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si la imagen pertenece a otro producto', async () => {
      prisma.tx.productImage.findUnique.mockResolvedValue(
        makeImageRow({ productId: 'other-product' }),
      );

      await expect(
        service.setPrimaryImage({
          productId: 'product-1',
          imageId: 'image-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lanza NotFoundException si la imagen no existe', async () => {
      prisma.tx.productImage.findUnique.mockResolvedValue(null);

      await expect(
        service.setPrimaryImage({
          productId: 'product-1',
          imageId: 'missing',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('removeImage', () => {
    it('elimina la fila, registra PRODUCT_IMAGE_REMOVED y borra el archivo físico tras el commit', async () => {
      prisma.tx.productImage.findUnique.mockResolvedValue(
        makeImageRow({ isPrimary: false }),
      );
      prisma.tx.productImage.delete.mockResolvedValue(makeImageRow());

      await service.removeImage({
        productId: 'product-1',
        imageId: 'image-1',
        actorUserId: ACTOR_ID,
      });

      expect(prisma.tx.productImage.delete).toHaveBeenCalledWith({
        where: { id: 'image-1' },
      });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PRODUCT_IMAGE_REMOVED,
          metadata: { imageId: 'image-1', wasPrimary: false },
        }),
      );
      expect(imageStorage.delete).toHaveBeenCalledWith('product-1/uuid-1.jpg');
    });

    it('lanza NotFoundException si la imagen pertenece a otro producto', async () => {
      prisma.tx.productImage.findUnique.mockResolvedValue(
        makeImageRow({ productId: 'other-product' }),
      );

      await expect(
        service.removeImage({
          productId: 'product-1',
          imageId: 'image-1',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.tx.productImage.delete).not.toHaveBeenCalled();
    });

    it('promueve la siguiente imagen por sortOrder/createdAt al eliminar la principal', async () => {
      prisma.tx.productImage.findUnique.mockResolvedValue(
        makeImageRow({ isPrimary: true }),
      );
      prisma.tx.productImage.delete.mockResolvedValue(makeImageRow());
      prisma.tx.productImage.findFirst.mockResolvedValue({ id: 'image-2' });

      await service.removeImage({
        productId: 'product-1',
        imageId: 'image-1',
        actorUserId: ACTOR_ID,
      });

      expect(prisma.tx.productImage.update).toHaveBeenCalledWith({
        where: { id: 'image-2' },
        data: { isPrimary: true },
      });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PRODUCT_PRIMARY_IMAGE_CHANGED,
          metadata: { previousImageId: 'image-1', newImageId: 'image-2' },
        }),
      );
    });

    it('si no quedan imágenes tras eliminar la principal, no promueve ninguna', async () => {
      prisma.tx.productImage.findUnique.mockResolvedValue(
        makeImageRow({ isPrimary: true }),
      );
      prisma.tx.productImage.delete.mockResolvedValue(makeImageRow());
      prisma.tx.productImage.findFirst.mockResolvedValue(null);

      await service.removeImage({
        productId: 'product-1',
        imageId: 'image-1',
        actorUserId: ACTOR_ID,
      });

      expect(prisma.tx.productImage.update).not.toHaveBeenCalled();
    });

    it('un fallo al eliminar el archivo físico después del commit no revierte ni lanza', async () => {
      prisma.tx.productImage.findUnique.mockResolvedValue(
        makeImageRow({ isPrimary: false }),
      );
      prisma.tx.productImage.delete.mockResolvedValue(makeImageRow());
      imageStorage.delete.mockRejectedValue(new Error('fallo de filesystem'));

      await expect(
        service.removeImage({
          productId: 'product-1',
          imageId: 'image-1',
          actorUserId: ACTOR_ID,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('openImageFile', () => {
    it('devuelve el stream y metadata cuando todo es válido', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: 'product-1',
        status: ProductStatus.ACTIVE,
      });
      prisma.productImage.findUnique.mockResolvedValue(makeImageRow());
      imageStorage.exists.mockResolvedValue(true);
      const stream = Readable.from(['contenido']);
      imageStorage.createReadStream.mockReturnValue(stream);

      const result = await service.openImageFile(
        { productId: 'product-1', imageId: 'image-1' },
        RoleName.ADMIN,
      );

      expect(result.mimeType).toBe('image/jpeg');
      expect(result.stream).toBe(stream);
    });

    it('SELLER no puede abrir imágenes de un producto INACTIVE (404)', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: 'product-1',
        status: ProductStatus.INACTIVE,
      });

      await expect(
        service.openImageFile(
          { productId: 'product-1', imageId: 'image-1' },
          RoleName.SELLER,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT])(
      '%s sí puede abrir imágenes de un producto INACTIVE',
      async (role) => {
        prisma.product.findUnique.mockResolvedValue({
          id: 'product-1',
          status: ProductStatus.INACTIVE,
        });
        prisma.productImage.findUnique.mockResolvedValue(makeImageRow());
        imageStorage.exists.mockResolvedValue(true);
        imageStorage.createReadStream.mockReturnValue(Readable.from(['x']));

        await expect(
          service.openImageFile(
            { productId: 'product-1', imageId: 'image-1' },
            role,
          ),
        ).resolves.toBeDefined();
      },
    );

    it('responde 404 si la fila existe pero el archivo físico no existe', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: 'product-1',
        status: ProductStatus.ACTIVE,
      });
      prisma.productImage.findUnique.mockResolvedValue(makeImageRow());
      imageStorage.exists.mockResolvedValue(false);

      await expect(
        service.openImageFile(
          { productId: 'product-1', imageId: 'image-1' },
          RoleName.ADMIN,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('no expone storagePath en el resultado', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: 'product-1',
        status: ProductStatus.ACTIVE,
      });
      prisma.productImage.findUnique.mockResolvedValue(makeImageRow());
      imageStorage.exists.mockResolvedValue(true);
      imageStorage.createReadStream.mockReturnValue(Readable.from(['x']));

      const result = await service.openImageFile(
        { productId: 'product-1', imageId: 'image-1' },
        RoleName.ADMIN,
      );

      expect(result).not.toHaveProperty('storagePath');
    });
  });
});

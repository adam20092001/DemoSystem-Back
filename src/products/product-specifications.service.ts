import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { toSafeProductSpecification } from './mappers/product.mapper';
import {
  CreateProductSpecificationInput,
  DeleteProductSpecificationInput,
  UpdateProductSpecificationInput,
} from './types/product-specification.input';
import { SafeProductSpecification } from './types/safe-product';

const SPEC_SELECT = {
  id: true,
  name: true,
  value: true,
  unit: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductSpecificationSelect;

/**
 * Vive dentro de ProductsModule: las especificaciones no tienen ciclo de
 * vida propio fuera de un producto, así que no ameritan un módulo Nest
 * independiente.
 */
@Injectable()
export class ProductSpecificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async createSpecification(
    input: CreateProductSpecificationInput,
  ): Promise<SafeProductSpecification> {
    const name = input.name.trim();
    const value = input.value.trim();
    const unit = normalizeOptional(input.unit);

    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: { id: input.productId },
        select: { id: true },
      });
      if (product === null) {
        throw new NotFoundException('Producto no encontrado');
      }

      const created = await tx.productSpecification.create({
        data: {
          productId: input.productId,
          name,
          value,
          unit,
          sortOrder: input.sortOrder ?? 0,
        },
        select: SPEC_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PRODUCTS',
        action: AuditAction.PRODUCT_SPECIFICATION_CHANGED,
        entityType: 'Product',
        entityId: input.productId,
        description: `Especificación ${name} creada`,
        metadata: { operation: 'CREATED', specificationName: name },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeProductSpecification(created);
    });
  }

  async updateSpecification(
    input: UpdateProductSpecificationInput,
  ): Promise<SafeProductSpecification> {
    const hasAnyField =
      input.name !== undefined ||
      input.value !== undefined ||
      input.unit !== undefined ||
      input.sortOrder !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar: name, value, unit o sortOrder',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await this.findOwnedSpecification(
        tx,
        input.productId,
        input.specificationId,
      );

      const data: Prisma.ProductSpecificationUpdateInput = {};
      let effectiveName = existing.name;

      if (input.name !== undefined) {
        data.name = input.name.trim();
        effectiveName = data.name;
      }
      if (input.value !== undefined) {
        data.value = input.value.trim();
      }
      if (input.unit !== undefined) {
        data.unit = normalizeOptional(input.unit);
      }
      if (input.sortOrder !== undefined) {
        data.sortOrder = input.sortOrder;
      }

      const updated = await tx.productSpecification.update({
        where: { id: input.specificationId },
        data,
        select: SPEC_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PRODUCTS',
        action: AuditAction.PRODUCT_SPECIFICATION_CHANGED,
        entityType: 'Product',
        entityId: input.productId,
        description: `Especificación ${effectiveName} actualizada`,
        metadata: { operation: 'UPDATED', specificationName: effectiveName },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeProductSpecification(updated);
    });
  }

  async deleteSpecification(
    input: DeleteProductSpecificationInput,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.findOwnedSpecification(
        tx,
        input.productId,
        input.specificationId,
      );

      await tx.productSpecification.delete({
        where: { id: input.specificationId },
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PRODUCTS',
        action: AuditAction.PRODUCT_SPECIFICATION_CHANGED,
        entityType: 'Product',
        entityId: input.productId,
        description: `Especificación ${existing.name} eliminada`,
        metadata: { operation: 'DELETED', specificationName: existing.name },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });
    });
  }

  /**
   * Verifica que la especificación exista y pertenezca al producto de la
   * ruta. No confía en que specificationId por sí solo sea suficiente.
   */
  private async findOwnedSpecification(
    tx: Prisma.TransactionClient,
    productId: string,
    specificationId: string,
  ): Promise<{ id: string; productId: string; name: string }> {
    const specification = await tx.productSpecification.findUnique({
      where: { id: specificationId },
      select: { id: true, productId: true, name: true },
    });
    if (specification === null || specification.productId !== productId) {
      throw new NotFoundException('Especificación no encontrada');
    }
    return specification;
  }
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

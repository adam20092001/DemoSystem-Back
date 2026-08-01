import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CategoryStatus,
  Prisma,
  ProductStatus,
  ProductType,
  RoleName,
  UnitStatus,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import {
  canSeeInternalNotes,
  PRODUCT_DETAIL_SELECT,
  PRODUCT_LIST_SELECT,
  toSafeProductDetail,
  toSafeProductListItem,
} from './mappers/product.mapper';
import { CreateProductInput } from './types/create-product.input';
import { ListProductsQuery } from './types/list-products.query';
import { ProductStatusActionInput } from './types/product-status-action.input';
import { SafeProductDetail, SafeProductListItem } from './types/safe-product';
import { UpdateProductInput } from './types/update-product.input';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Estado relevante para validar la regla PRODUCT/SERVICE. */
interface ServiceRuleState {
  productType: ProductType;
  isInventoryTracked: boolean;
  stockMinimum: Prisma.Decimal;
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async createProduct(input: CreateProductInput): Promise<SafeProductDetail> {
    const sku = normalizeUpper(input.sku);
    const name = input.name.trim();
    const brand = normalizeOptional(input.brand);
    const commercialDescription = normalizeOptional(
      input.commercialDescription,
    );
    const internalNotes = normalizeOptional(input.internalNotes);
    const salePrice = new Prisma.Decimal(input.salePrice);
    const stockMinimum = new Prisma.Decimal(input.stockMinimum ?? '0');

    this.assertServiceRules({
      productType: input.productType,
      isInventoryTracked: input.isInventoryTracked,
      stockMinimum,
    });

    return this.prisma.$transaction(async (tx) => {
      await this.assertCategoryUsable(tx, input.categoryId);
      await this.assertUnitUsable(tx, input.unitId);

      const created = await tx.product.create({
        data: {
          sku,
          name,
          brand,
          productType: input.productType,
          categoryId: input.categoryId,
          unitId: input.unitId,
          salePrice,
          commercialDescription,
          internalNotes,
          isInventoryTracked: input.isInventoryTracked,
          stockCurrent: new Prisma.Decimal(0),
          stockMinimum,
          status: ProductStatus.ACTIVE,
        },
        select: PRODUCT_DETAIL_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PRODUCTS',
        action: AuditAction.PRODUCT_CREATED,
        entityType: 'Product',
        entityId: created.id,
        description: `Producto ${sku} creado`,
        metadata: {
          sku,
          productType: input.productType,
          categoryId: input.categoryId,
          unitId: input.unitId,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeProductDetail(created, true);
    });
  }

  async listProducts(
    query: ListProductsQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeProductListItem>> {
    const page =
      query.page !== undefined && query.page > 0
        ? Math.floor(query.page)
        : DEFAULT_PAGE;
    const limit = Math.min(
      query.limit !== undefined && query.limit > 0
        ? Math.floor(query.limit)
        : DEFAULT_LIMIT,
      MAX_LIMIT,
    );
    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = {};
    if (requesterRole === RoleName.SELLER) {
      where.status = ProductStatus.ACTIVE;
    } else if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.categoryId !== undefined) {
      where.categoryId = query.categoryId;
    }
    if (query.unitId !== undefined) {
      where.unitId = query.unitId;
    }
    if (query.productType !== undefined) {
      where.productType = query.productType;
    }
    if (query.isInventoryTracked !== undefined) {
      where.isInventoryTracked = query.isInventoryTracked;
    }
    const term = query.search?.trim();
    if (term !== undefined && term.length > 0) {
      where.OR = [
        { sku: { contains: term, mode: 'insensitive' } },
        { name: { contains: term, mode: 'insensitive' } },
        { brand: { contains: term, mode: 'insensitive' } },
      ];
    }

    const showNotes = canSeeInternalNotes(requesterRole);

    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        select: PRODUCT_LIST_SELECT,
        orderBy: [{ name: 'asc' }, { sku: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data: rows.map((row) => toSafeProductListItem(row, showNotes)),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  async findProductById(
    id: string,
    requesterRole: RoleName,
  ): Promise<SafeProductDetail> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      select: PRODUCT_DETAIL_SELECT,
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
    return toSafeProductDetail(product, canSeeInternalNotes(requesterRole));
  }

  async updateProduct(input: UpdateProductInput): Promise<SafeProductDetail> {
    const hasAnyField =
      input.sku !== undefined ||
      input.name !== undefined ||
      input.brand !== undefined ||
      input.productType !== undefined ||
      input.categoryId !== undefined ||
      input.unitId !== undefined ||
      input.salePrice !== undefined ||
      input.commercialDescription !== undefined ||
      input.internalNotes !== undefined ||
      input.isInventoryTracked !== undefined ||
      input.stockMinimum !== undefined;
    if (!hasAnyField) {
      throw new BadRequestException(
        'Debe proveerse al menos un campo para actualizar',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.product.findUnique({
        where: { id: input.productId },
        select: {
          id: true,
          sku: true,
          productType: true,
          isInventoryTracked: true,
          stockMinimum: true,
          salePrice: true,
        },
      });
      if (existing === null) {
        throw new NotFoundException('Producto no encontrado');
      }

      const data: Prisma.ProductUpdateInput = {};
      const updatedFields: string[] = [];

      if (input.sku !== undefined) {
        data.sku = normalizeUpper(input.sku);
        updatedFields.push('sku');
      }
      if (input.name !== undefined) {
        data.name = input.name.trim();
        updatedFields.push('name');
      }
      if (input.brand !== undefined) {
        data.brand = normalizeOptional(input.brand);
        updatedFields.push('brand');
      }
      if (input.commercialDescription !== undefined) {
        data.commercialDescription = normalizeOptional(
          input.commercialDescription,
        );
        updatedFields.push('commercialDescription');
      }
      if (input.internalNotes !== undefined) {
        data.internalNotes = normalizeOptional(input.internalNotes);
        updatedFields.push('internalNotes');
      }

      let newSalePrice: Prisma.Decimal | undefined;
      if (input.salePrice !== undefined) {
        newSalePrice = new Prisma.Decimal(input.salePrice);
        data.salePrice = newSalePrice;
        updatedFields.push('salePrice');
      }

      if (input.productType !== undefined) {
        data.productType = input.productType;
        updatedFields.push('productType');
      }
      if (input.isInventoryTracked !== undefined) {
        data.isInventoryTracked = input.isInventoryTracked;
        updatedFields.push('isInventoryTracked');
      }

      let newStockMinimum: Prisma.Decimal | undefined;
      if (input.stockMinimum !== undefined) {
        newStockMinimum = new Prisma.Decimal(input.stockMinimum);
        data.stockMinimum = newStockMinimum;
        updatedFields.push('stockMinimum');
      }

      if (input.categoryId !== undefined) {
        await this.assertCategoryUsable(tx, input.categoryId);
        data.category = { connect: { id: input.categoryId } };
        updatedFields.push('categoryId');
      }
      if (input.unitId !== undefined) {
        await this.assertUnitUsable(tx, input.unitId);
        data.unit = { connect: { id: input.unitId } };
        updatedFields.push('unitId');
      }

      // Estado efectivo: lo enviado prevalece; si no se envía, se conserva
      // lo almacenado. Nunca se confía únicamente en el payload aislado.
      this.assertServiceRules({
        productType: input.productType ?? existing.productType,
        isInventoryTracked:
          input.isInventoryTracked ?? existing.isInventoryTracked,
        stockMinimum: newStockMinimum ?? existing.stockMinimum,
      });

      const updated = await tx.product.update({
        where: { id: input.productId },
        data,
        select: PRODUCT_DETAIL_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PRODUCTS',
        action: AuditAction.PRODUCT_UPDATED,
        entityType: 'Product',
        entityId: input.productId,
        description: `Producto ${existing.sku} actualizado`,
        metadata: { updatedFields },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      if (
        newSalePrice !== undefined &&
        !existing.salePrice.equals(newSalePrice)
      ) {
        await this.auditService.record({
          userId: input.actorUserId,
          module: 'PRODUCTS',
          action: AuditAction.PRODUCT_PRICE_CHANGED,
          entityType: 'Product',
          entityId: input.productId,
          description: `Precio de ${existing.sku} modificado`,
          metadata: {
            oldPrice: existing.salePrice.toFixed(2),
            newPrice: newSalePrice.toFixed(2),
          },
          ipAddress: input.ipAddress ?? null,
          client: tx,
        });
      }

      return toSafeProductDetail(updated, true);
    });
  }

  async activateProduct(
    input: ProductStatusActionInput,
  ): Promise<SafeProductDetail> {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: { id: input.productId },
        select: {
          id: true,
          sku: true,
          status: true,
          productType: true,
          isInventoryTracked: true,
          stockMinimum: true,
          categoryId: true,
          unitId: true,
        },
      });
      if (product === null) {
        throw new NotFoundException('Producto no encontrado');
      }
      if (product.status === ProductStatus.ACTIVE) {
        throw new ConflictException('El producto ya está activo');
      }

      await this.assertCategoryUsable(tx, product.categoryId);
      await this.assertUnitUsable(tx, product.unitId);
      this.assertServiceRules({
        productType: product.productType,
        isInventoryTracked: product.isInventoryTracked,
        stockMinimum: product.stockMinimum,
      });

      const activated = await tx.product.update({
        where: { id: input.productId },
        data: { status: ProductStatus.ACTIVE },
        select: PRODUCT_DETAIL_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PRODUCTS',
        action: AuditAction.PRODUCT_ACTIVATED,
        entityType: 'Product',
        entityId: input.productId,
        description: `Producto ${product.sku} activado`,
        metadata: { sku: product.sku },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeProductDetail(activated, true);
    });
  }

  async deactivateProduct(
    input: ProductStatusActionInput,
  ): Promise<SafeProductDetail> {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: { id: input.productId },
        select: { id: true, sku: true, status: true },
      });
      if (product === null) {
        throw new NotFoundException('Producto no encontrado');
      }
      if (product.status === ProductStatus.INACTIVE) {
        throw new ConflictException('El producto ya está inactivo');
      }

      const deactivated = await tx.product.update({
        where: { id: input.productId },
        data: { status: ProductStatus.INACTIVE },
        select: PRODUCT_DETAIL_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PRODUCTS',
        action: AuditAction.PRODUCT_DEACTIVATED,
        entityType: 'Product',
        entityId: input.productId,
        description: `Producto ${product.sku} desactivado`,
        metadata: { sku: product.sku },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });

      return toSafeProductDetail(deactivated, true);
    });
  }

  /**
   * SERVICE nunca controla inventario: ni isInventoryTracked=true ni
   * stockMinimum distinto de cero. No corrige en silencio, rechaza.
   */
  private assertServiceRules(state: ServiceRuleState): void {
    if (state.productType !== ProductType.SERVICE) {
      return;
    }
    if (state.isInventoryTracked) {
      throw new BadRequestException(
        'Un producto de tipo SERVICE no puede tener isInventoryTracked=true',
      );
    }
    if (!state.stockMinimum.equals(0)) {
      throw new BadRequestException(
        'Un producto de tipo SERVICE no puede tener stockMinimum distinto de cero',
      );
    }
  }

  private async assertCategoryUsable(
    tx: Prisma.TransactionClient,
    categoryId: string,
  ): Promise<void> {
    const category = await tx.category.findUnique({
      where: { id: categoryId },
      select: { status: true },
    });
    if (category === null) {
      throw new NotFoundException('La categoría no existe');
    }
    if (category.status !== CategoryStatus.ACTIVE) {
      throw new ConflictException('La categoría debe estar activa');
    }
  }

  private async assertUnitUsable(
    tx: Prisma.TransactionClient,
    unitId: string,
  ): Promise<void> {
    const unit = await tx.unit.findUnique({
      where: { id: unitId },
      select: { status: true },
    });
    if (unit === null) {
      throw new NotFoundException('La unidad no existe');
    }
    if (unit.status !== UnitStatus.ACTIVE) {
      throw new ConflictException('La unidad debe estar activa');
    }
  }
}

function normalizeUpper(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

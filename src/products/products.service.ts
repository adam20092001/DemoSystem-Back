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

    // Fase 9, Bloque A (R6): combinación contradictoria explícita — nunca
    // se resuelve en silencio con una página vacía.
    if (query.lowStockOnly === true && query.isInventoryTracked === false) {
      throw new BadRequestException(
        'lowStockOnly=true requiere productos inventariables; no puede combinarse con isInventoryTracked=false',
      );
    }
    const brandTerm = this.assertValidOptionalFilterTerm(query.brand, 'brand');

    const showNotes = canSeeInternalNotes(requesterRole);

    // Fase 9, Bloque A (R6): stockCurrent <= stockMinimum es una
    // comparación entre dos columnas de la misma fila, que Prisma no puede
    // expresar en su `where` tipado. Cuando lowStockOnly=true, se resuelve
    // con una consulta raw parametrizada (mismo criterio ya usado por
    // InventoryService.listLowStock), preservando en SQL exactamente los
    // mismos filtros/orden/paginación que la rama normal, y luego se
    // recupera la fila completa vía Prisma por id — nunca se pagina ni se
    // filtra en memoria.
    if (query.lowStockOnly === true) {
      return this.listProductsLowStockOnly(
        query,
        requesterRole,
        brandTerm,
        page,
        limit,
        skip,
        showNotes,
      );
    }

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
    if (brandTerm !== undefined) {
      where.brand = { contains: brandTerm, mode: 'insensitive' };
    }
    const term = query.search?.trim();
    if (term !== undefined && term.length > 0) {
      where.OR = [
        { sku: { contains: term, mode: 'insensitive' } },
        { name: { contains: term, mode: 'insensitive' } },
        { brand: { contains: term, mode: 'insensitive' } },
      ];
    }

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

  /**
   * Trim + rechazo de blanco cuando el filtro SÍ se envía (patrón ya usado
   * por `search` en este mismo servicio, aplicado explícitamente aquí
   * porque un valor en blanco después de trim debe fallar con 400, nunca
   * ignorarse en silencio como filtro ausente).
   */
  private assertValidOptionalFilterTerm(
    value: string | undefined,
    fieldName: string,
  ): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException(`${fieldName} no puede estar en blanco`);
    }
    return trimmed;
  }

  /**
   * Rama exclusiva de lowStockOnly=true (Fase 9, Bloque A, R6). Refleja
   * exactamente los mismos filtros que la rama normal (rol SELLER forzado
   * a ACTIVE, categoryId, unitId, productType, brand, search) más
   * isInventoryTracked=true forzado y la comparación de columnas que
   * Prisma no puede expresar. Orden idéntico a la rama normal: name ASC,
   * sku ASC. LIMIT/OFFSET ya aplicados en SQL: nunca se pagina en memoria.
   */
  private async listProductsLowStockOnly(
    query: ListProductsQuery,
    requesterRole: RoleName,
    brandTerm: string | undefined,
    page: number,
    limit: number,
    skip: number,
    showNotes: boolean,
  ): Promise<PaginatedResult<SafeProductListItem>> {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`p.is_inventory_tracked = true`,
      Prisma.sql`p.stock_current <= p.stock_minimum`,
    ];
    if (requesterRole === RoleName.SELLER) {
      conditions.push(Prisma.sql`p.status = 'ACTIVE'::"ProductStatus"`);
    } else if (query.status !== undefined) {
      conditions.push(Prisma.sql`p.status = ${query.status}::"ProductStatus"`);
    }
    if (query.categoryId !== undefined) {
      conditions.push(Prisma.sql`p.category_id = ${query.categoryId}::uuid`);
    }
    if (query.unitId !== undefined) {
      conditions.push(Prisma.sql`p.unit_id = ${query.unitId}::uuid`);
    }
    if (query.productType !== undefined) {
      conditions.push(
        Prisma.sql`p.product_type = ${query.productType}::"ProductType"`,
      );
    }
    if (brandTerm !== undefined) {
      conditions.push(Prisma.sql`p.brand ILIKE ${'%' + brandTerm + '%'}`);
    }
    const searchTerm = query.search?.trim();
    if (searchTerm !== undefined && searchTerm.length > 0) {
      const pattern = '%' + searchTerm + '%';
      conditions.push(
        Prisma.sql`(p.sku ILIKE ${pattern} OR p.name ILIKE ${pattern} OR p.brand ILIKE ${pattern})`,
      );
    }
    const whereClause = Prisma.join(conditions, ' AND ');

    const idRows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT p.id AS "id"
      FROM products p
      WHERE ${whereClause}
      ORDER BY p.name ASC, p.sku ASC
      LIMIT ${limit} OFFSET ${skip}
    `);
    const totalRows = await this.prisma.$queryRaw<{ total: number }[]>(
      Prisma.sql`
        SELECT COUNT(*)::int AS "total"
        FROM products p
        WHERE ${whereClause}
      `,
    );
    const total = totalRows[0]?.total ?? 0;

    const orderedIds = idRows.map((row) => row.id);
    const rows =
      orderedIds.length > 0
        ? await this.prisma.product.findMany({
            where: { id: { in: orderedIds } },
            select: PRODUCT_LIST_SELECT,
          })
        : [];
    // Prisma `where: { id: { in: [...] } }` no garantiza preservar el orden
    // de la lista: se reordena en memoria según `orderedIds` (ya acotado a
    // como máximo `limit` filas por la consulta raw paginada — nunca es un
    // reordenamiento sobre el conjunto completo sin paginar).
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const orderedRows = orderedIds
      .map((id) => rowsById.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined);

    return {
      data: orderedRows.map((row) => toSafeProductListItem(row, showNotes)),
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

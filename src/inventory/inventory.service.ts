import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CategoryStatus,
  InventoryMovementOrigin,
  InventoryMovementType,
  Prisma,
  ProductStatus,
  ProductType,
  RoleName,
  UnitStatus,
} from '@prisma/client';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import {
  INVENTORY_MOVEMENT_SAFE_SELECT,
  toSafeInventoryMovement,
} from './mappers/inventory-movement.mapper';
import { StockMovementEngine } from './stock-movement.engine';
import { ListLowStockQuery } from './types/list-low-stock.query';
import { ListMovementsQuery } from './types/list-movements.query';
import { RegisterMovementInput } from './types/register-movement.input';
import { SafeInventoryMovement } from './types/safe-inventory-movement';
import { SafeLowStockItem, SafeProductStock } from './types/safe-product-stock';
import { StockMovementCommand } from './types/stock-movement-command';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Fila de la consulta parametrizada de stock bajo (Prisma fluido no compara dos columnas de la misma fila). */
interface LowStockRow {
  id: string;
  sku: string;
  name: string;
  stockCurrent: Prisma.Decimal;
  stockMinimum: Prisma.Decimal;
  categoryId: string;
  categoryName: string;
  unitId: string;
  unitAbbreviation: string;
}

/**
 * Wrappers de escritura de inventario. Cada método abre exactamente una
 * transacción y delega toda la lógica (lock, validación, cálculo, escritura
 * y auditoría) en StockMovementEngine.apply(). Nunca ejecuta $queryRaw, ni
 * valida Product/Category/Unit, ni actualiza stockCurrent, ni crea
 * InventoryMovement, ni audita directamente.
 *
 * Los métodos de lectura (listMovements/findMovementById/
 * listProductMovements/getProductStock/listLowStock) usan Prisma de forma
 * fluida: no hay locks ni escritura involucrados.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: StockMovementEngine,
  ) {}

  async registerInitialBalance(
    input: RegisterMovementInput,
  ): Promise<SafeInventoryMovement> {
    return this.run(
      input,
      InventoryMovementType.ENTRY,
      InventoryMovementOrigin.INITIAL_BALANCE,
    );
  }

  async registerEntry(
    input: RegisterMovementInput,
  ): Promise<SafeInventoryMovement> {
    return this.run(
      input,
      InventoryMovementType.ENTRY,
      InventoryMovementOrigin.MANUAL,
    );
  }

  async registerExit(
    input: RegisterMovementInput,
  ): Promise<SafeInventoryMovement> {
    return this.run(
      input,
      InventoryMovementType.EXIT,
      InventoryMovementOrigin.MANUAL,
    );
  }

  async registerPositiveAdjustment(
    input: RegisterMovementInput,
  ): Promise<SafeInventoryMovement> {
    return this.run(
      input,
      InventoryMovementType.ADJUSTMENT_IN,
      InventoryMovementOrigin.MANUAL,
    );
  }

  async registerNegativeAdjustment(
    input: RegisterMovementInput,
  ): Promise<SafeInventoryMovement> {
    return this.run(
      input,
      InventoryMovementType.ADJUSTMENT_OUT,
      InventoryMovementOrigin.MANUAL,
    );
  }

  async listMovements(
    query: ListMovementsQuery,
  ): Promise<PaginatedResult<SafeInventoryMovement>> {
    return this.queryMovements(query);
  }

  async findMovementById(id: string): Promise<SafeInventoryMovement> {
    const movement = await this.prisma.inventoryMovement.findUnique({
      where: { id },
      select: INVENTORY_MOVEMENT_SAFE_SELECT,
    });
    if (movement === null) {
      throw new NotFoundException('Movimiento no encontrado');
    }
    return toSafeInventoryMovement(movement);
  }

  /** El kardex es histórico: no exige que producto/categoría/unidad estén activos. */
  async listProductMovements(
    productId: string,
    query: ListMovementsQuery,
  ): Promise<PaginatedResult<SafeInventoryMovement>> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (product === null) {
      throw new NotFoundException('Producto no encontrado');
    }
    return this.queryMovements({ ...query, productId });
  }

  /**
   * SELLER solo ve stock de productos operativos (producto, categoría y
   * unidad ACTIVE); en cualquier otro caso, 404 genérico sin revelar cuál
   * de los tres está inactivo. ADMIN/WAREHOUSE/MANAGEMENT consultan sin esa
   * restricción (administración e histórico).
   */
  async getProductStock(
    productId: string,
    requesterRole: RoleName,
  ): Promise<SafeProductStock> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        sku: true,
        name: true,
        productType: true,
        isInventoryTracked: true,
        status: true,
        stockCurrent: true,
        stockMinimum: true,
        category: { select: { status: true } },
        unit: {
          select: { status: true, abbreviation: true, allowDecimal: true },
        },
      },
    });
    if (product === null) {
      throw new NotFoundException('Producto no encontrado');
    }
    if (product.productType === ProductType.SERVICE) {
      throw new BadRequestException('Un servicio no controla inventario');
    }
    if (!product.isInventoryTracked) {
      throw new BadRequestException('El producto no controla inventario');
    }
    if (requesterRole === RoleName.SELLER) {
      const allActive =
        product.status === ProductStatus.ACTIVE &&
        product.category.status === CategoryStatus.ACTIVE &&
        product.unit.status === UnitStatus.ACTIVE;
      if (!allActive) {
        throw new NotFoundException('Producto no encontrado');
      }
    }
    return {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      stockCurrent: product.stockCurrent.toFixed(3),
      stockMinimum: product.stockMinimum.toFixed(3),
      unitAbbreviation: product.unit.abbreviation,
      allowDecimal: product.unit.allowDecimal,
    };
  }

  /**
   * SQL parametrizado: Prisma fluido no puede comparar stockCurrent contra
   * stockMinimum de la misma fila. Nunca $queryRawUnsafe ni concatenación;
   * Prisma.sql + Prisma.join componen el WHERE, compartido entre datos y
   * COUNT.
   */
  async listLowStock(
    query: ListLowStockQuery,
  ): Promise<PaginatedResult<SafeLowStockItem>> {
    const page = normalizePage(query.page);
    const limit = normalizeLimit(query.limit);
    const skip = (page - 1) * limit;

    const conditions: Prisma.Sql[] = [
      Prisma.sql`p.status = 'ACTIVE'::"ProductStatus"`,
      Prisma.sql`p.product_type = 'PRODUCT'::"ProductType"`,
      Prisma.sql`p.is_inventory_tracked = true`,
      Prisma.sql`c.status = 'ACTIVE'::"CategoryStatus"`,
      Prisma.sql`u.status = 'ACTIVE'::"UnitStatus"`,
      Prisma.sql`p.stock_current <= p.stock_minimum`,
    ];
    if (query.categoryId !== undefined) {
      conditions.push(Prisma.sql`p.category_id = ${query.categoryId}::uuid`);
    }
    if (query.unitId !== undefined) {
      conditions.push(Prisma.sql`p.unit_id = ${query.unitId}::uuid`);
    }
    const term = query.search?.trim();
    if (term !== undefined && term.length > 0) {
      conditions.push(
        Prisma.sql`(p.sku ILIKE ${'%' + term + '%'} OR p.name ILIKE ${'%' + term + '%'})`,
      );
    }
    const whereClause = Prisma.join(conditions, ' AND ');

    const rows = await this.prisma.$queryRaw<LowStockRow[]>(Prisma.sql`
      SELECT
        p.id             AS "id",
        p.sku            AS "sku",
        p.name           AS "name",
        p.stock_current  AS "stockCurrent",
        p.stock_minimum  AS "stockMinimum",
        c.id             AS "categoryId",
        c.name           AS "categoryName",
        u.id             AS "unitId",
        u.abbreviation   AS "unitAbbreviation"
      FROM products p
      JOIN categories c ON c.id = p.category_id
      JOIN units u ON u.id = p.unit_id
      WHERE ${whereClause}
      ORDER BY p.name ASC, p.sku ASC, p.id ASC
      LIMIT ${limit} OFFSET ${skip}
    `);

    const totalRows = await this.prisma.$queryRaw<{ total: number }[]>(
      Prisma.sql`
        SELECT COUNT(*)::int AS "total"
        FROM products p
        JOIN categories c ON c.id = p.category_id
        JOIN units u ON u.id = p.unit_id
        WHERE ${whereClause}
      `,
    );
    const total = totalRows[0]?.total ?? 0;

    return {
      data: rows.map((row) => ({
        id: row.id,
        sku: row.sku,
        name: row.name,
        stockCurrent: row.stockCurrent.toFixed(3),
        stockMinimum: row.stockMinimum.toFixed(3),
        category: { id: row.categoryId, name: row.categoryName },
        unit: { id: row.unitId, abbreviation: row.unitAbbreviation },
      })),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  private async queryMovements(
    query: ListMovementsQuery,
  ): Promise<PaginatedResult<SafeInventoryMovement>> {
    if (
      query.dateFrom !== undefined &&
      query.dateTo !== undefined &&
      query.dateFrom > query.dateTo
    ) {
      throw new BadRequestException('dateFrom no puede ser mayor que dateTo');
    }

    const page = normalizePage(query.page);
    const limit = normalizeLimit(query.limit);
    const skip = (page - 1) * limit;

    const where: Prisma.InventoryMovementWhereInput = {};
    if (query.productId !== undefined) {
      where.productId = query.productId;
    }
    if (query.movementType !== undefined) {
      where.movementType = query.movementType;
    }
    if (query.origin !== undefined) {
      where.origin = query.origin;
    }
    if (query.createdByUserId !== undefined) {
      where.createdByUserId = query.createdByUserId;
    }
    if (query.dateFrom !== undefined || query.dateTo !== undefined) {
      where.createdAt = {
        ...(query.dateFrom !== undefined ? { gte: query.dateFrom } : {}),
        ...(query.dateTo !== undefined ? { lte: query.dateTo } : {}),
      };
    }
    const term = query.search?.trim();
    if (term !== undefined && term.length > 0) {
      where.product = {
        OR: [
          { sku: { contains: term, mode: 'insensitive' } },
          { name: { contains: term, mode: 'insensitive' } },
        ],
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.inventoryMovement.findMany({
        where,
        select: INVENTORY_MOVEMENT_SAFE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.inventoryMovement.count({ where }),
    ]);

    return {
      data: rows.map(toSafeInventoryMovement),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  private async run(
    input: RegisterMovementInput,
    movementType: InventoryMovementType,
    origin: InventoryMovementOrigin,
  ): Promise<SafeInventoryMovement> {
    const quantity = this.toDecimalQuantity(input.quantity);
    const command: StockMovementCommand = {
      productId: input.productId,
      quantity,
      movementType,
      origin,
      reason: input.reason,
      notes: input.notes ?? null,
      actorUserId: input.actorUserId,
      ipAddress: input.ipAddress ?? null,
      referenceType: null,
      referenceId: null,
    };
    return this.prisma.$transaction((tx) => this.engine.apply(tx, command));
  }

  /**
   * new Prisma.Decimal() puede lanzar si un llamador interno construye
   * RegisterMovementInput con una cantidad mal formada (no pasó por un DTO
   * HTTP con class-validator). Solo se traduce el error de conversión en
   * sí a 400; cualquier otro error del motor se propaga sin alterar.
   */
  private toDecimalQuantity(quantity: string): Prisma.Decimal {
    if (typeof quantity !== 'string') {
      throw new BadRequestException(
        'La cantidad debe ser un texto numérico válido',
      );
    }
    try {
      return new Prisma.Decimal(quantity);
    } catch {
      throw new BadRequestException(
        'La cantidad debe ser un texto numérico válido',
      );
    }
  }
}

function normalizePage(page: number | undefined): number {
  return page !== undefined && page > 0 ? Math.floor(page) : DEFAULT_PAGE;
}

function normalizeLimit(limit: number | undefined): number {
  return Math.min(
    limit !== undefined && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT,
    MAX_LIMIT,
  );
}

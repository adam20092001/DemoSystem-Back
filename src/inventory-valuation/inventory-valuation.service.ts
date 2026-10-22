import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  InventoryMovementOrigin,
  InventoryMovementType,
  InventoryValuationEventType,
  Prisma,
  RoleName,
} from '@prisma/client';
import { computeWeightedAverage } from './inventory-valuation-calculator';
import { PaginatedResult } from '../common/types/paginated-result';
import { PrismaService } from '../database/prisma.service';
import {
  ListPendingValuationQuery,
  ListValuedInventoryQuery,
} from './types/list-valued-inventory.query';
import {
  PendingValuationItem,
  ValuedInventoryItem,
} from './types/valued-inventory-item';

const ZERO = new Prisma.Decimal(0);
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Lectura de cuentas/costos (Fase A6.1): ADMIN/ACCOUNTANT/MANAGEMENT —
 * NUNCA SELLER/WAREHOUSE (CLAUDE.md §7: "No exponer costos a SELLER o
 * WAREHOUSE"). A diferencia del resto del dominio de Inventario
 * (`GET /inventory/low-stock`, accesible a WAREHOUSE sin exponer costo),
 * esta superficie SIEMPRE expone costo — por eso WAREHOUSE queda fuera
 * aquí a propósito, aunque tenga acceso general a Inventario en otros
 * endpoints.
 */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
]);

function assertCanRead(requesterRole: RoleName): void {
  if (!READ_ROLES.has(requesterRole)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar la valorización de inventario',
    );
  }
}

/**
 * Consultas de solo lectura de existencias valorizadas (Fase A6.1). Nunca
 * escribe InventoryValuation (InventoryValuationEngine es su único
 * escritor) ni Product.stockCurrent (StockMovementEngine). Toda cifra
 * agregada (cantidad valorizada, costo unitario promedio, valor total) se
 * calcula SIEMPRE replay-ando InventoryValuation — nunca una columna
 * duplicada.
 */
@Injectable()
export class InventoryValuationService {
  constructor(private readonly prisma: PrismaService) {}

  async getValuedInventory(
    query: ListValuedInventoryQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<ValuedInventoryItem>> {
    assertCanRead(requesterRole);

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

    const where: Prisma.ProductWhereInput = { valuationMethod: { not: null } };
    if (query.productId !== undefined) {
      where.id = query.productId;
    }

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        select: {
          id: true,
          sku: true,
          name: true,
          stockCurrent: true,
          valuationMethod: true,
        },
        orderBy: [{ sku: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    const productIds = products.map((p) => p.id);
    const aggregates = await this.computeValuationAggregates(productIds);

    const data: ValuedInventoryItem[] = products.map((product) => {
      const agg = aggregates.get(product.id) ?? { quantity: ZERO, value: ZERO };
      return {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        method: product.valuationMethod!,
        physicalStockCurrent: product.stockCurrent.toFixed(3),
        valuedQuantity: agg.quantity.toFixed(3),
        weightedAverageUnitCost: computeWeightedAverage(
          agg.quantity,
          agg.value,
        ).toFixed(6),
        totalValue: agg.value.toFixed(2),
      };
    });

    return {
      data,
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  /** Movimientos ENTRY por recepción de compra, de un producto con valorización habilitada, todavía sin evento de valorización. */
  async getPendingValuation(
    query: ListPendingValuationQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<PendingValuationItem>> {
    assertCanRead(requesterRole);

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

    const where: Prisma.InventoryMovementWhereInput = {
      origin: InventoryMovementOrigin.PURCHASE_RECEIPT,
      movementType: InventoryMovementType.ENTRY,
      product: { valuationMethod: { not: null } },
      inventoryValuation: { is: null },
    };
    if (query.productId !== undefined) {
      where.productId = query.productId;
    }

    const [movements, total] = await Promise.all([
      this.prisma.inventoryMovement.findMany({
        where,
        select: {
          id: true,
          productId: true,
          quantity: true,
          referenceType: true,
          referenceId: true,
          createdAt: true,
          product: { select: { sku: true, name: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.inventoryMovement.count({ where }),
    ]);

    const data: PendingValuationItem[] = movements.map((m) => ({
      inventoryMovementId: m.id,
      productId: m.productId,
      sku: m.product.sku,
      name: m.product.name,
      purchaseReceiptId:
        m.referenceType === 'PurchaseReceipt' ? m.referenceId : null,
      quantity: m.quantity.toFixed(3),
      createdAt: m.createdAt,
    }));

    return {
      data,
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  private async computeValuationAggregates(
    productIds: string[],
  ): Promise<Map<string, { quantity: Prisma.Decimal; value: Prisma.Decimal }>> {
    if (productIds.length === 0) {
      return new Map();
    }
    const [originals, reversals] = await Promise.all([
      this.prisma.inventoryValuation.groupBy({
        by: ['productId'],
        where: {
          productId: { in: productIds },
          eventType: InventoryValuationEventType.ORIGINAL,
        },
        _sum: { quantity: true, totalCost: true },
      }),
      this.prisma.inventoryValuation.groupBy({
        by: ['productId'],
        where: {
          productId: { in: productIds },
          eventType: InventoryValuationEventType.REVERSAL,
        },
        _sum: { quantity: true, totalCost: true },
      }),
    ]);

    const result = new Map<
      string,
      { quantity: Prisma.Decimal; value: Prisma.Decimal }
    >();
    for (const row of originals) {
      result.set(row.productId, {
        quantity: row._sum.quantity ?? ZERO,
        value: row._sum.totalCost ?? ZERO,
      });
    }
    for (const row of reversals) {
      const existing = result.get(row.productId) ?? {
        quantity: ZERO,
        value: ZERO,
      };
      result.set(row.productId, {
        quantity: existing.quantity.minus(row._sum.quantity ?? ZERO),
        value: existing.value.minus(row._sum.totalCost ?? ZERO),
      });
    }
    return result;
  }
}

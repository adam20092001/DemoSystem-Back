import { ConflictException, Injectable } from '@nestjs/common';
import {
  InventoryValuationEventType,
  InventoryValuationSourceType,
  Prisma,
  PurchaseReceiptStatus,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import {
  computeReceiptValuationCost,
  computeSaleConsumptionCost,
  assertValidValuationQuantity,
  valuationEventSign,
} from './inventory-valuation-calculator';
import {
  INVENTORY_VALUATION_SAFE_SELECT,
  toSafeInventoryValuation,
} from './mappers/inventory-valuation.mapper';
import { RecordOriginalValuationCommand } from './types/record-original-valuation.command';
import { RecordSaleConsumptionCommand } from './types/record-sale-consumption.command';
import {
  ReverseValuationForLineCommand,
  ReverseValuationForSaleItemCommand,
} from './types/reverse-valuation.command';
import { SafeInventoryValuation } from './types/safe-inventory-valuation';

const ZERO = new Prisma.Decimal(0);

/** Costo consumido/reinstalado por un evento de valorización por venta (Fase A6.2), para que el llamador acumule líneas de COGS sin reparsear strings. */
export interface SaleValuationResult {
  valuation: SafeInventoryValuation;
  totalCost: Prisma.Decimal;
}

/**
 * Único propietario de la escritura de InventoryValuation y de su
 * AuditLog (mismo criterio que StockMovementEngine/AccountingEngine).
 * Nunca abre transacción propia ni inyecta PrismaService: `tx` es
 * siempre la transacción del llamador (PurchaseReceiptsService, dentro
 * de la MISMA transacción que ya mueve stock vía StockMovementEngine —
 * garantiza atomicidad: si la valorización falla, el movimiento físico
 * tampoco se confirma). Nunca escribe InventoryMovement/
 * Product.stockCurrent: eso sigue siendo responsabilidad EXCLUSIVA de
 * StockMovementEngine. Ambos métodos son NO-OP silencioso (retornan
 * null) cuando el producto no tiene `valuationMethod` configurado — cero
 * cambio de comportamiento del inventario físico para un producto sin
 * valorización habilitada.
 */
@Injectable()
export class InventoryValuationEngine {
  constructor(private readonly auditService: AuditService) {}

  /**
   * Registra el evento ORIGINAL de valorización de UN InventoryMovement
   * ENTRY recién creado por una recepción física (A5.2b). No-op (null)
   * si `Product.valuationMethod` es NULL en este instante — la
   * elegibilidad de valorización se lee aquí, fresca, bajo el MISMO lock
   * de producto que StockMovementEngine.apply() ya tomó en esta misma
   * transacción (FOR UPDATE), así que no hace falta un segundo lock.
   */
  async recordOriginal(
    tx: Prisma.TransactionClient,
    command: RecordOriginalValuationCommand,
  ): Promise<SafeInventoryValuation | null> {
    assertValidValuationQuantity(command.quantity);

    const product = await tx.product.findUniqueOrThrow({
      where: { id: command.productId },
      select: { valuationMethod: true },
    });
    if (product.valuationMethod === null) {
      return null;
    }

    const existing = await tx.inventoryValuation.findUnique({
      where: { inventoryMovementId: command.inventoryMovementId },
      select: { id: true },
    });
    if (existing !== null) {
      // Defensa en profundidad: PurchaseReceiptsService ya corta cualquier
      // reintento HTTP antes de generar un movimiento nuevo — esto nunca
      // debería ocurrir en operación normal.
      throw new ConflictException(
        'Este movimiento de inventario ya fue valorizado anteriormente',
      );
    }

    // Monto ya capitalizado por recepciones ACTIVE PREVIAS de la MISMA
    // PurchaseInvoiceLine (nunca incluye la recepción actual, que todavía
    // no tiene fila de valorización) — misma fuente de verdad exacta que
    // PurchaseReceiptsService usa para el chequeo de sobre-recepción.
    const priorValuations = await tx.inventoryValuation.findMany({
      where: {
        eventType: InventoryValuationEventType.ORIGINAL,
        purchaseReceiptLine: {
          purchaseInvoiceLineId: command.purchaseInvoiceLineId,
          purchaseReceipt: { status: PurchaseReceiptStatus.ACTIVE },
        },
      },
      select: { totalCost: true },
    });
    const alreadyCapitalizedAmount = priorValuations.reduce(
      (sum, v) => sum.plus(v.totalCost),
      ZERO,
    );

    const cost = computeReceiptValuationCost(
      command.lineFinancials,
      command.invoicedQuantity,
      command.priorReceivedQuantity,
      command.quantity,
      alreadyCapitalizedAmount,
    );

    if (cost.totalCost.lessThanOrEqualTo(0)) {
      // Línea sin ningún monto elegible (p. ej. línea gratuita/ya agotada
      // por redondeo): nada que capitalizar, pero el producto SÍ tiene
      // valorización habilitada — registrar un evento de costo 0 no
      // aporta trazabilidad real y complicaría el promedio ponderado sin
      // necesidad. Se omite sin error: el movimiento físico ya ocurrió
      // igual, vía StockMovementEngine.
      return null;
    }

    const created = await tx.inventoryValuation.create({
      data: {
        productId: command.productId,
        inventoryMovementId: command.inventoryMovementId,
        sourceType: InventoryValuationSourceType.PURCHASE_RECEIPT,
        purchaseReceiptLineId: command.purchaseReceiptLineId,
        eventType: InventoryValuationEventType.ORIGINAL,
        method: product.valuationMethod,
        quantity: command.quantity,
        purchasePriceAmount: cost.purchasePriceAmount,
        nonCreditableTaxAmount: cost.nonCreditableTaxAmount,
        additionalCostsAmount: cost.additionalCostsAmount,
        totalCost: cost.totalCost,
        unitCost: cost.unitCost,
        createdByUserId: command.actorUserId,
      },
      select: INVENTORY_VALUATION_SAFE_SELECT,
    });

    await this.auditService.record({
      userId: command.actorUserId,
      module: 'INVENTORY_VALUATION',
      action: AuditAction.INVENTORY_VALUATION_RECORDED,
      entityType: 'InventoryValuation',
      entityId: created.id,
      description: `Valorización de inventario registrada para el producto ${command.productId}`,
      metadata: {
        valuationId: created.id,
        productId: command.productId,
        inventoryMovementId: command.inventoryMovementId,
        purchaseReceiptLineId: command.purchaseReceiptLineId,
      },
      ipAddress: command.ipAddress,
      client: tx,
    });

    return toSafeInventoryValuation(created);
  }

  /**
   * Revierte, si existe, el evento ORIGINAL de valorización de la
   * PurchaseReceiptLine siendo cancelada. No-op (null) si esa línea
   * nunca se valorizó (producto sin valorización habilitada en el
   * instante de recibir, o línea sin monto elegible) — cero cambio de
   * comportamiento. Nunca recalcula el costo: reutiliza EXACTAMENTE los
   * mismos componentes del ORIGINAL, mismo criterio que
   * AccountingEngine.reverseOriginalForSource().
   */
  async reverseForReceiptLine(
    tx: Prisma.TransactionClient,
    command: ReverseValuationForLineCommand,
  ): Promise<SafeInventoryValuation | null> {
    const original = await tx.inventoryValuation.findFirst({
      where: {
        purchaseReceiptLineId: command.purchaseReceiptLineId,
        eventType: InventoryValuationEventType.ORIGINAL,
      },
    });
    if (original === null) {
      return null;
    }

    const existingReversal = await tx.inventoryValuation.findFirst({
      where: { reversesValuationId: original.id },
      select: { id: true },
    });
    if (existingReversal !== null) {
      throw new ConflictException(
        'Esta valorización ya fue revertida anteriormente',
      );
    }

    // Protección contra reversión incorrecta de costo ya consumido por
    // movimientos posteriores (CLAUDE.md A6.1 §5, ahora real desde A6.2):
    // el pool vigente del producto (ORIGINAL−REVERSAL de AMBOS sourceType,
    // con signo unificado — ver computeCurrentPool()) debe alcanzar para
    // absorber esta reversión; si una venta ya consumió lo suficiente, se
    // bloquea en vez de dejar la cantidad valorizada en negativo.
    const currentPool = await this.computeCurrentPool(tx, original.productId);
    if (currentPool.quantity.lessThan(original.quantity)) {
      throw new ConflictException(
        'No se puede revertir: la cantidad valorizada vigente del producto ya fue reducida por movimientos posteriores',
      );
    }

    const created = await tx.inventoryValuation.create({
      data: {
        productId: original.productId,
        inventoryMovementId: command.newInventoryMovementId,
        sourceType: InventoryValuationSourceType.PURCHASE_RECEIPT,
        purchaseReceiptLineId: command.purchaseReceiptLineId,
        eventType: InventoryValuationEventType.REVERSAL,
        reversesValuationId: original.id,
        method: original.method,
        quantity: original.quantity,
        purchasePriceAmount: original.purchasePriceAmount,
        nonCreditableTaxAmount: original.nonCreditableTaxAmount,
        additionalCostsAmount: original.additionalCostsAmount,
        totalCost: original.totalCost,
        unitCost: original.unitCost,
        createdByUserId: command.actorUserId,
      },
      select: INVENTORY_VALUATION_SAFE_SELECT,
    });

    await this.auditService.record({
      userId: command.actorUserId,
      module: 'INVENTORY_VALUATION',
      action: AuditAction.INVENTORY_VALUATION_REVERSED,
      entityType: 'InventoryValuation',
      entityId: created.id,
      description: `Valorización de inventario revertida para el producto ${original.productId}`,
      metadata: {
        valuationId: created.id,
        reversesValuationId: original.id,
        productId: original.productId,
      },
      ipAddress: command.ipAddress,
      client: tx,
    });

    return toSafeInventoryValuation(created);
  }

  /**
   * Registra el evento ORIGINAL de consumo de costo de UN InventoryMovement
   * EXIT recién creado por la salida física de una venta confirmada (Fase
   * A6.2). No-op (null) si `Product.valuationMethod` es NULL — mismo
   * criterio exacto que recordOriginal(): cero cambio de comportamiento
   * para un producto sin valorización habilitada. Bloquea (409) cuando el
   * pool valorizado vigente del producto no alcanza para costear esta
   * salida — nunca inventa costo (CLAUDE.md A6.2 §2): "bloquear el costeo
   * obligatorio cuando el stock físico no cuenta con costo valorizado
   * suficiente". El costo exacto se calcula con el promedio ponderado
   * vigente ANTES de este consumo, con residual exacto en agotamiento
   * total (computeSaleConsumptionCost) — nunca recalculado después.
   */
  async recordSaleConsumption(
    tx: Prisma.TransactionClient,
    command: RecordSaleConsumptionCommand,
  ): Promise<SaleValuationResult | null> {
    assertValidValuationQuantity(command.quantity);

    const product = await tx.product.findUniqueOrThrow({
      where: { id: command.productId },
      select: { valuationMethod: true },
    });
    if (product.valuationMethod === null) {
      return null;
    }

    const existing = await tx.inventoryValuation.findUnique({
      where: { inventoryMovementId: command.inventoryMovementId },
      select: { id: true },
    });
    if (existing !== null) {
      // Defensa en profundidad: SalesService ya corta cualquier reintento
      // HTTP antes de generar un movimiento nuevo — esto nunca debería
      // ocurrir en operación normal.
      throw new ConflictException(
        'Este movimiento de inventario ya fue valorizado anteriormente',
      );
    }

    const pool = await this.computeCurrentPool(tx, command.productId);
    if (pool.quantity.lessThan(command.quantity)) {
      throw new ConflictException(
        'No se puede costear esta venta: el stock físico del producto no cuenta con costo valorizado suficiente',
      );
    }

    const cost = computeSaleConsumptionCost(
      pool.quantity,
      pool.value,
      command.quantity,
    );

    const created = await tx.inventoryValuation.create({
      data: {
        productId: command.productId,
        inventoryMovementId: command.inventoryMovementId,
        sourceType: InventoryValuationSourceType.SALE,
        saleItemId: command.saleItemId,
        eventType: InventoryValuationEventType.ORIGINAL,
        method: product.valuationMethod,
        quantity: command.quantity,
        // Desglose no aplicable a un consumo por venta (ver comentario del
        // modelo en schema.prisma): todo el costo cae en purchasePriceAmount.
        purchasePriceAmount: cost.totalCost,
        nonCreditableTaxAmount: ZERO,
        additionalCostsAmount: ZERO,
        totalCost: cost.totalCost,
        unitCost: cost.unitCost,
        createdByUserId: command.actorUserId,
      },
      select: INVENTORY_VALUATION_SAFE_SELECT,
    });

    await this.auditService.record({
      userId: command.actorUserId,
      module: 'INVENTORY_VALUATION',
      action: AuditAction.INVENTORY_VALUATION_RECORDED,
      entityType: 'InventoryValuation',
      entityId: created.id,
      description: `Costo de venta consumido para el producto ${command.productId}`,
      metadata: {
        valuationId: created.id,
        productId: command.productId,
        inventoryMovementId: command.inventoryMovementId,
        sourceType: created.sourceType,
        saleItemId: command.saleItemId,
      },
      ipAddress: command.ipAddress,
      client: tx,
    });

    return {
      valuation: toSafeInventoryValuation(created),
      totalCost: cost.totalCost,
    };
  }

  /**
   * Revierte, si existe, el evento ORIGINAL de consumo de costo del
   * SaleItem siendo anulado (Fase A6.2) — mismo criterio exacto que
   * reverseForReceiptLine(): no-op (null) si ese ítem nunca se costeó
   * (producto sin valorización habilitada al confirmar la venta), nunca
   * recalcula el costo (reutiliza EXACTAMENTE los mismos componentes del
   * ORIGINAL).
   */
  async reverseForSaleItem(
    tx: Prisma.TransactionClient,
    command: ReverseValuationForSaleItemCommand,
  ): Promise<SaleValuationResult | null> {
    const original = await tx.inventoryValuation.findFirst({
      where: {
        saleItemId: command.saleItemId,
        sourceType: InventoryValuationSourceType.SALE,
        eventType: InventoryValuationEventType.ORIGINAL,
      },
    });
    if (original === null) {
      return null;
    }

    const existingReversal = await tx.inventoryValuation.findFirst({
      where: { reversesValuationId: original.id },
      select: { id: true },
    });
    if (existingReversal !== null) {
      throw new ConflictException(
        'Esta valorización ya fue revertida anteriormente',
      );
    }

    const created = await tx.inventoryValuation.create({
      data: {
        productId: original.productId,
        inventoryMovementId: command.newInventoryMovementId,
        sourceType: InventoryValuationSourceType.SALE,
        saleItemId: command.saleItemId,
        eventType: InventoryValuationEventType.REVERSAL,
        reversesValuationId: original.id,
        method: original.method,
        quantity: original.quantity,
        purchasePriceAmount: original.purchasePriceAmount,
        nonCreditableTaxAmount: original.nonCreditableTaxAmount,
        additionalCostsAmount: original.additionalCostsAmount,
        totalCost: original.totalCost,
        unitCost: original.unitCost,
        createdByUserId: command.actorUserId,
      },
      select: INVENTORY_VALUATION_SAFE_SELECT,
    });

    await this.auditService.record({
      userId: command.actorUserId,
      module: 'INVENTORY_VALUATION',
      action: AuditAction.INVENTORY_VALUATION_REVERSED,
      entityType: 'InventoryValuation',
      entityId: created.id,
      description: `Costo de venta revertido para el producto ${original.productId}`,
      metadata: {
        valuationId: created.id,
        reversesValuationId: original.id,
        productId: original.productId,
        sourceType: created.sourceType,
        saleItemId: command.saleItemId,
      },
      ipAddress: command.ipAddress,
      client: tx,
    });

    return {
      valuation: toSafeInventoryValuation(created),
      totalCost: original.totalCost,
    };
  }

  /**
   * Pool agregado vigente de UN producto, DENTRO de la transacción del
   * llamador (Fase A6.2) — ORIGINAL−REVERSAL de AMBOS sourceType, cada
   * grupo aplicado con su signo unificado (valuationEventSign). Reutilizado
   * por recordSaleConsumption() (cuánto hay disponible para costear) y por
   * reverseForReceiptLine() (si una reversión de compra dejaría el pool en
   * negativo) — nunca dos fórmulas de agregación paralelas.
   */
  private async computeCurrentPool(
    tx: Prisma.TransactionClient,
    productId: string,
  ): Promise<{ quantity: Prisma.Decimal; value: Prisma.Decimal }> {
    const groups = await tx.inventoryValuation.groupBy({
      by: ['sourceType', 'eventType'],
      where: { productId },
      _sum: { quantity: true, totalCost: true },
    });

    let quantity = ZERO;
    let value = ZERO;
    for (const row of groups) {
      const sign = valuationEventSign(row.sourceType, row.eventType);
      quantity = quantity.plus((row._sum.quantity ?? ZERO).mul(sign));
      value = value.plus((row._sum.totalCost ?? ZERO).mul(sign));
    }
    return { quantity, value };
  }
}

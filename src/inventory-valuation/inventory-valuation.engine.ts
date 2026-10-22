import { ConflictException, Injectable } from '@nestjs/common';
import {
  InventoryValuationEventType,
  Prisma,
  PurchaseReceiptStatus,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import {
  computeReceiptValuationCost,
  assertValidValuationQuantity,
} from './inventory-valuation-calculator';
import {
  INVENTORY_VALUATION_SAFE_SELECT,
  toSafeInventoryValuation,
} from './mappers/inventory-valuation.mapper';
import { RecordOriginalValuationCommand } from './types/record-original-valuation.command';
import { ReverseValuationForLineCommand } from './types/reverse-valuation.command';
import { SafeInventoryValuation } from './types/safe-inventory-valuation';

const ZERO = new Prisma.Decimal(0);

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
    // movimientos posteriores (CLAUDE.md A6.1 §5): A6.1 todavía no resta
    // valorización por venta (COGS, A6.2), así que esta comprobación
    // nunca debería bloquear nada HOY — existe como salvaguarda
    // explícita para cuando A6.2 exista, en vez de improvisar un
    // recálculo. Si algún día la cantidad valorizada vigente del
    // producto no alcanza para absorber esta reversión, se bloquea en
    // vez de dejar la cantidad valorizada en negativo.
    const [totalOriginalQty, totalReversalQty] = await Promise.all([
      tx.inventoryValuation.aggregate({
        where: {
          productId: original.productId,
          eventType: InventoryValuationEventType.ORIGINAL,
        },
        _sum: { quantity: true },
      }),
      tx.inventoryValuation.aggregate({
        where: {
          productId: original.productId,
          eventType: InventoryValuationEventType.REVERSAL,
        },
        _sum: { quantity: true },
      }),
    ]);
    const currentValuedQuantity = (
      totalOriginalQty._sum.quantity ?? ZERO
    ).minus(totalReversalQty._sum.quantity ?? ZERO);
    if (currentValuedQuantity.lessThan(original.quantity)) {
      throw new ConflictException(
        'No se puede revertir: la cantidad valorizada vigente del producto ya fue reducida por movimientos posteriores',
      );
    }

    const created = await tx.inventoryValuation.create({
      data: {
        productId: original.productId,
        inventoryMovementId: command.newInventoryMovementId,
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
}

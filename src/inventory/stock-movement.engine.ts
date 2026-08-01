import {
  BadRequestException,
  ConflictException,
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
  UnitStatus,
} from '@prisma/client';
import { isUUID } from 'class-validator';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { MAX_STOCK_VALUE } from './constants/inventory-decimal.constants';
import {
  INVENTORY_MOVEMENT_SAFE_SELECT,
  toSafeInventoryMovement,
} from './mappers/inventory-movement.mapper';
import { SafeInventoryMovement } from './types/safe-inventory-movement';
import { StockMovementCommand } from './types/stock-movement-command';

const REASON_MAX_LENGTH = 200;
const NOTES_MAX_LENGTH = 500;
const REFERENCE_TYPE_MAX_LENGTH = 50;
const REFERENCE_ID_MAX_LENGTH = 64;

/** Dirección del cambio de stock derivada exclusivamente de movementType. */
const STOCK_DELTA_SIGN: Record<InventoryMovementType, 1 | -1> = {
  [InventoryMovementType.ENTRY]: 1,
  [InventoryMovementType.ADJUSTMENT_IN]: 1,
  [InventoryMovementType.EXIT]: -1,
  [InventoryMovementType.ADJUSTMENT_OUT]: -1,
};

/** null = compatible con los 4 movementType (MANUAL/OTHER). */
const ALLOWED_ORIGIN_MOVEMENT_TYPES: Record<
  InventoryMovementOrigin,
  readonly InventoryMovementType[] | null
> = {
  [InventoryMovementOrigin.INITIAL_BALANCE]: [InventoryMovementType.ENTRY],
  [InventoryMovementOrigin.SALE]: [InventoryMovementType.EXIT],
  [InventoryMovementOrigin.SALE_CANCELLATION]: [InventoryMovementType.ENTRY],
  [InventoryMovementOrigin.MANUAL]: null,
  [InventoryMovementOrigin.OTHER]: null,
};

/** Fila devuelta por la única consulta de lock del motor. */
interface LockedProductRow {
  productId: string;
  productType: ProductType;
  isInventoryTracked: boolean;
  productStatus: ProductStatus;
  stockCurrent: Prisma.Decimal;
  categoryId: string;
  categoryStatus: CategoryStatus;
  unitId: string;
  unitStatus: UnitStatus;
  allowDecimal: boolean;
}

/**
 * Único propietario del lock sobre Product/Category/Unit y única vía que
 * escribe Product.stockCurrent, crea InventoryMovement y audita el
 * movimiento. No inyecta PrismaService ni abre transacción propia: `tx` es
 * un parámetro obligatorio, siempre la transacción abierta por el llamador
 * (InventoryService hoy; SalesService en el futuro, dentro de la misma
 * transacción de la venta). Para operaciones futuras que muevan varios
 * productos, invocar apply() en orden ascendente de productId para reducir
 * el riesgo de deadlocks entre transacciones concurrentes con productos
 * solapados.
 */
@Injectable()
export class StockMovementEngine {
  constructor(private readonly auditService: AuditService) {}

  /**
   * Aplica un movimiento de stock dentro de la transacción `tx` recibida.
   * Nunca abre `prisma.$transaction()`: el llamador es el único dueño del
   * commit/rollback. Valida el comando completo en tiempo de ejecución (no
   * confía en que TypeScript ya lo garantizó), toma un único lock sobre
   * Product/Category/Unit, calcula el nuevo saldo y registra auditoría en
   * la misma transacción.
   */
  async apply(
    tx: Prisma.TransactionClient,
    command: StockMovementCommand,
  ): Promise<SafeInventoryMovement> {
    this.validateActorAndProductIds(command.productId, command.actorUserId);
    this.validateQuantityShape(command.quantity);
    const normalizedReason = this.normalizeReason(command.reason);
    const normalizedNotes = this.normalizeNotes(command.notes);
    const {
      referenceType: normalizedReferenceType,
      referenceId: normalizedReferenceId,
    } = this.normalizeReferences(command.referenceType, command.referenceId);
    this.validateOriginMovementTypeCombination(
      command.origin,
      command.movementType,
    );

    const rows = await tx.$queryRaw<LockedProductRow[]>(Prisma.sql`
      SELECT
        p.id                   AS "productId",
        p.product_type         AS "productType",
        p.is_inventory_tracked AS "isInventoryTracked",
        p.status               AS "productStatus",
        p.stock_current        AS "stockCurrent",
        c.id                   AS "categoryId",
        c.status               AS "categoryStatus",
        u.id                   AS "unitId",
        u.status               AS "unitStatus",
        u.allow_decimal        AS "allowDecimal"
      FROM products p
      JOIN categories c ON c.id = p.category_id
      JOIN units u ON u.id = p.unit_id
      WHERE p.id = ${command.productId}::uuid
      FOR UPDATE OF p
      FOR SHARE OF c, u
    `);

    const locked = rows[0];
    if (locked === undefined) {
      throw new NotFoundException('Producto no encontrado');
    }

    this.validateLockedProduct(locked);
    this.validateQuantityAgainstUnit(command.quantity, locked.allowDecimal);

    if (command.origin === InventoryMovementOrigin.INITIAL_BALANCE) {
      await this.validateInitialBalance(
        tx,
        command.productId,
        command.movementType,
        locked.stockCurrent,
        normalizedReferenceType,
        normalizedReferenceId,
      );
    }

    const previousStock = locked.stockCurrent;
    const sign = STOCK_DELTA_SIGN[command.movementType];
    const newStock =
      sign === 1
        ? previousStock.plus(command.quantity)
        : previousStock.minus(command.quantity);

    if (newStock.lessThan(0)) {
      throw new ConflictException(
        'Stock insuficiente para completar el movimiento',
      );
    }
    if (newStock.greaterThan(MAX_STOCK_VALUE)) {
      throw new ConflictException(
        'El movimiento supera la capacidad máxima de stock permitida',
      );
    }

    await tx.product.update({
      where: { id: command.productId },
      data: { stockCurrent: newStock },
    });

    const created = await tx.inventoryMovement.create({
      data: {
        productId: command.productId,
        movementType: command.movementType,
        origin: command.origin,
        quantity: command.quantity,
        previousStock,
        newStock,
        reason: normalizedReason,
        notes: normalizedNotes,
        referenceType: normalizedReferenceType,
        referenceId: normalizedReferenceId,
        createdByUserId: command.actorUserId,
      },
      select: INVENTORY_MOVEMENT_SAFE_SELECT,
    });

    await this.auditService.record({
      userId: command.actorUserId,
      module: 'INVENTORY',
      action: this.resolveAuditAction(command),
      entityType: 'InventoryMovement',
      entityId: created.id,
      description: `Movimiento de inventario ${command.movementType} registrado`,
      metadata: {
        movementId: created.id,
        productId: command.productId,
        quantity: command.quantity.toFixed(3),
        previousStock: previousStock.toFixed(3),
        newStock: newStock.toFixed(3),
        movementType: command.movementType,
        origin: command.origin,
      },
      ipAddress: command.ipAddress,
      client: tx,
    });

    return toSafeInventoryMovement(created);
  }

  private validateActorAndProductIds(
    productId: string,
    actorUserId: string,
  ): void {
    if (typeof productId !== 'string' || !isUUID(productId)) {
      throw new BadRequestException(
        'El identificador del producto no es válido',
      );
    }
    if (typeof actorUserId !== 'string' || !isUUID(actorUserId)) {
      throw new BadRequestException(
        'El identificador del usuario no es válido',
      );
    }
  }

  /** No confía en que TypeScript ya garantizó que quantity es un Decimal real. */
  private validateQuantityShape(quantity: Prisma.Decimal): void {
    if (!Prisma.Decimal.isDecimal(quantity)) {
      throw new BadRequestException(
        'La cantidad debe ser un valor decimal válido',
      );
    }
    if (!quantity.isFinite()) {
      throw new BadRequestException('La cantidad debe ser un número finito');
    }
    if (quantity.lessThanOrEqualTo(0)) {
      throw new BadRequestException('La cantidad debe ser mayor que cero');
    }
    if (quantity.decimalPlaces() > 3) {
      throw new BadRequestException(
        'La cantidad admite como máximo 3 decimales',
      );
    }
    if (quantity.greaterThan(MAX_STOCK_VALUE)) {
      throw new BadRequestException('La cantidad excede el máximo permitido');
    }
  }

  private normalizeReason(reason: string): string {
    if (typeof reason !== 'string') {
      throw new BadRequestException('El motivo es obligatorio');
    }
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException('El motivo no puede estar vacío');
    }
    if (trimmed.length > REASON_MAX_LENGTH) {
      throw new BadRequestException(
        'El motivo no puede superar los 200 caracteres',
      );
    }
    return trimmed;
  }

  private normalizeNotes(notes: string | null): string | null {
    if (notes === null || notes === undefined) {
      return null;
    }
    if (typeof notes !== 'string') {
      throw new BadRequestException('Las notas deben ser un texto');
    }
    const trimmed = notes.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed.length > NOTES_MAX_LENGTH) {
      throw new BadRequestException(
        'Las notas no pueden superar los 500 caracteres',
      );
    }
    return trimmed;
  }

  private normalizeReferences(
    referenceType: string | null,
    referenceId: string | null,
  ): { referenceType: string | null; referenceId: string | null } {
    const hasType = referenceType !== null && referenceType !== undefined;
    const hasId = referenceId !== null && referenceId !== undefined;
    if (hasType !== hasId) {
      throw new BadRequestException(
        'La referencia debe incluir tipo e identificador, o ninguno de los dos',
      );
    }
    if (!hasType) {
      return { referenceType: null, referenceId: null };
    }
    if (typeof referenceType !== 'string' || typeof referenceId !== 'string') {
      throw new BadRequestException('La referencia debe ser un texto válido');
    }
    const trimmedType = referenceType.trim();
    const trimmedId = referenceId.trim();
    if (trimmedType.length === 0 || trimmedId.length === 0) {
      throw new BadRequestException('La referencia no puede estar vacía');
    }
    if (trimmedType.length > REFERENCE_TYPE_MAX_LENGTH) {
      throw new BadRequestException(
        'El tipo de referencia no puede superar los 50 caracteres',
      );
    }
    if (trimmedId.length > REFERENCE_ID_MAX_LENGTH) {
      throw new BadRequestException(
        'El identificador de referencia no puede superar los 64 caracteres',
      );
    }
    return { referenceType: trimmedType, referenceId: trimmedId };
  }

  private validateOriginMovementTypeCombination(
    origin: InventoryMovementOrigin,
    movementType: InventoryMovementType,
  ): void {
    if (!Object.values(InventoryMovementOrigin).includes(origin)) {
      throw new BadRequestException('El origen del movimiento no es válido');
    }
    if (!Object.values(InventoryMovementType).includes(movementType)) {
      throw new BadRequestException('El tipo de movimiento no es válido');
    }
    const allowed = ALLOWED_ORIGIN_MOVEMENT_TYPES[origin];
    if (allowed !== null && !allowed.includes(movementType)) {
      throw new BadRequestException(
        'La combinación de origen y tipo de movimiento no es válida',
      );
    }
  }

  private validateLockedProduct(locked: LockedProductRow): void {
    if (locked.productType === ProductType.SERVICE) {
      throw new BadRequestException('Un servicio no controla inventario');
    }
    if (!locked.isInventoryTracked) {
      throw new BadRequestException('El producto no controla inventario');
    }
    if (locked.productStatus !== ProductStatus.ACTIVE) {
      throw new ConflictException('El producto debe estar activo');
    }
    if (locked.categoryStatus !== CategoryStatus.ACTIVE) {
      throw new ConflictException(
        'La categoría del producto debe estar activa',
      );
    }
    if (locked.unitStatus !== UnitStatus.ACTIVE) {
      throw new ConflictException('La unidad del producto debe estar activa');
    }
  }

  private validateQuantityAgainstUnit(
    quantity: Prisma.Decimal,
    allowDecimal: boolean,
  ): void {
    if (!allowDecimal && !quantity.isInteger()) {
      throw new BadRequestException(
        'La unidad del producto no admite cantidades fraccionarias',
      );
    }
  }

  /**
   * Toda la lógica de saldo inicial vive aquí, tras el único lock del
   * producto. El count() usa el mismo tx: como el paso anterior ya tomó
   * FOR UPDATE sobre el producto, cualquier otra transacción concurrente
   * sobre el mismo producto ya está serializada; no hace falta un segundo
   * lock para que este conteo sea seguro.
   */
  private async validateInitialBalance(
    tx: Prisma.TransactionClient,
    productId: string,
    movementType: InventoryMovementType,
    previousStock: Prisma.Decimal,
    referenceType: string | null,
    referenceId: string | null,
  ): Promise<void> {
    if (movementType !== InventoryMovementType.ENTRY) {
      throw new BadRequestException(
        'El saldo inicial debe registrarse como una entrada',
      );
    }
    if (!previousStock.equals(0)) {
      throw new ConflictException(
        'El producto ya tiene stock distinto de cero; no admite saldo inicial',
      );
    }
    if (referenceType !== null || referenceId !== null) {
      throw new BadRequestException('El saldo inicial no admite referencia');
    }
    const previousMovementsCount = await tx.inventoryMovement.count({
      where: { productId },
    });
    if (previousMovementsCount > 0) {
      throw new ConflictException(
        'El producto ya registra movimientos; no admite saldo inicial',
      );
    }
  }

  /** Precedencia: INITIAL_BALANCE se resuelve antes del mapeo por movementType. */
  private resolveAuditAction(command: StockMovementCommand): AuditAction {
    if (command.origin === InventoryMovementOrigin.INITIAL_BALANCE) {
      return AuditAction.INVENTORY_INITIAL_BALANCE_CREATED;
    }
    switch (command.movementType) {
      case InventoryMovementType.ENTRY:
        return AuditAction.INVENTORY_ENTRY_CREATED;
      case InventoryMovementType.EXIT:
        return AuditAction.INVENTORY_EXIT_CREATED;
      case InventoryMovementType.ADJUSTMENT_IN:
        return AuditAction.INVENTORY_ADJUSTMENT_IN_CREATED;
      case InventoryMovementType.ADJUSTMENT_OUT:
        return AuditAction.INVENTORY_ADJUSTMENT_OUT_CREATED;
    }
  }
}

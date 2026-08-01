import { BadRequestException, Injectable } from '@nestjs/common';
import {
  InventoryMovementOrigin,
  InventoryMovementType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { StockMovementEngine } from './stock-movement.engine';
import { RegisterMovementInput } from './types/register-movement.input';
import { SafeInventoryMovement } from './types/safe-inventory-movement';
import { StockMovementCommand } from './types/stock-movement-command';

/**
 * Wrappers de escritura de inventario. Cada método abre exactamente una
 * transacción y delega toda la lógica (lock, validación, cálculo, escritura
 * y auditoría) en StockMovementEngine.apply(). Nunca ejecuta $queryRaw, ni
 * valida Product/Category/Unit, ni actualiza stockCurrent, ni crea
 * InventoryMovement, ni audita directamente.
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

import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryMovementOrigin,
  InventoryMovementType,
  Prisma,
  RoleName,
} from '@prisma/client';
import { AuditAction } from '../../audit/audit-action.enum';
import { AuditService } from '../../audit/audit.service';
import { PaginatedResult } from '../../common/types/paginated-result';
import { PrismaService } from '../../database/prisma.service';
import { STOCK_TRANSFER_REFERENCE_TYPE } from '../mappers/inventory-movement.mapper';
import { StockMovementEngine } from '../stock-movement.engine';
import {
  STOCK_TRANSFER_SAFE_SELECT,
  StockTransferSafeRow,
  toSafeStockTransfer,
} from './mappers/stock-transfer.mapper';
import {
  CreateStockTransferInput,
  ListStockTransfersQuery,
} from './types/create-stock-transfer.input';
import { SafeStockTransfer } from './types/safe-stock-transfer';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const REASON_MAX_LENGTH = 200;
const NOTES_MAX_LENGTH = 500;
const IDEMPOTENCY_KEY_MAX_LENGTH = 100;

/** Misma política que los movimientos manuales de inventario (R2-C, decisión aprobada). */
const CREATE_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.WAREHOUSE,
]);
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.WAREHOUSE,
  RoleName.MANAGEMENT,
]);

/** Contenido canónico de una transferencia, para comparar un reintento idempotente. */
interface CanonicalTransfer {
  productId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  quantity: string;
  reason: string;
  notes: string | null;
}

/**
 * Transferencias de stock entre ubicaciones (R2-C). Un documento INMUTABLE
 * por producto: EXIT en el origen + ENTRY en el destino, ambos vía
 * StockMovementEngine (origin=TRANSFER) dentro de UNA transacción. Nunca
 * inyecta ni llama a los motores de valorización o contabilidad: una
 * transferencia no es una compra ni una venta y no tiene efecto financiero.
 * Product.stockCurrent no cambia (sale lo mismo que entra).
 */
@Injectable()
export class StockTransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly engine: StockMovementEngine,
  ) {}

  async create(input: CreateStockTransferInput): Promise<SafeStockTransfer> {
    if (!CREATE_ROLES.has(input.requesterRole)) {
      throw new ForbiddenException(
        'No tiene permisos para registrar transferencias de stock',
      );
    }

    const canonical = this.normalize(input);
    const idempotencyKey = this.normalizeIdempotencyKey(input.idempotencyKey);
    const quantity = new Prisma.Decimal(canonical.quantity);

    return this.prisma.$transaction(async (tx) => {
      // 1) Documento / idempotencia. Dos solicitudes con la misma clave se
      // serializan aquí: la segunda espera a que la primera confirme y
      // entonces encuentra la transferencia ya creada.
      if (idempotencyKey !== null) {
        await tx.$queryRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`stock-transfer:${input.actorUserId}:${idempotencyKey}`}, 0))::text AS locked`,
        );
        const existing = await tx.stockTransfer.findUnique({
          where: {
            createdByUserId_idempotencyKey: {
              createdByUserId: input.actorUserId,
              idempotencyKey,
            },
          },
          select: STOCK_TRANSFER_SAFE_SELECT,
        });
        if (existing !== null) {
          if (!this.sameContent(existing, canonical)) {
            throw new ConflictException(
              'La clave de idempotencia ya se usó con un contenido distinto',
            );
          }
          return toSafeStockTransfer(existing);
        }
      }

      // 2) Almacenes y ubicaciones de AMBOS extremos FOR SHARE, en una sola
      // llamada determinista y ANTES de bloquear el producto. Las llamadas
      // internas de apply() vuelven a tomar filas ya bloqueadas: ninguna
      // adquisición nueva de catálogo después del bloqueo del producto.
      await this.engine.lockLocationsShared(tx, [
        canonical.sourceLocationId,
        canonical.destinationLocationId,
      ]);

      // 3) EXIT en el origen y ENTRY en el destino. El motor valida producto
      // activo e inventariable, saldo PROPIO del origen (409) y mantiene la
      // conciliación stockCurrent = Σ saldos. Cualquier fallo revierte todo.
      const transferId = randomUUID();
      const exit = await this.engine.apply(tx, {
        productId: canonical.productId,
        quantity,
        movementType: InventoryMovementType.EXIT,
        origin: InventoryMovementOrigin.TRANSFER,
        reason: canonical.reason,
        notes: canonical.notes,
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress,
        referenceType: STOCK_TRANSFER_REFERENCE_TYPE,
        referenceId: transferId,
        locationId: canonical.sourceLocationId,
      });
      const entry = await this.engine.apply(tx, {
        productId: canonical.productId,
        quantity,
        movementType: InventoryMovementType.ENTRY,
        origin: InventoryMovementOrigin.TRANSFER,
        reason: canonical.reason,
        notes: canonical.notes,
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress,
        referenceType: STOCK_TRANSFER_REFERENCE_TYPE,
        referenceId: transferId,
        locationId: canonical.destinationLocationId,
      });

      const created = await tx.stockTransfer.create({
        data: {
          id: transferId,
          productId: canonical.productId,
          sourceLocationId: canonical.sourceLocationId,
          destinationLocationId: canonical.destinationLocationId,
          quantity,
          reason: canonical.reason,
          notes: canonical.notes,
          idempotencyKey,
          createdByUserId: input.actorUserId,
          exitMovementId: exit.id,
          entryMovementId: entry.id,
        },
        select: STOCK_TRANSFER_SAFE_SELECT,
      });

      await this.auditService.record({
        userId: input.actorUserId,
        module: 'INVENTORY',
        action: AuditAction.INVENTORY_TRANSFER_CREATED,
        entityType: 'StockTransfer',
        entityId: created.id,
        description: `Transferencia de stock ${created.id} registrada`,
        metadata: {
          transferId: created.id,
          productId: canonical.productId,
          quantity: quantity.toFixed(3),
          sourceLocationId: canonical.sourceLocationId,
          destinationLocationId: canonical.destinationLocationId,
          exitMovementId: exit.id,
          entryMovementId: entry.id,
        },
        ipAddress: input.ipAddress,
        client: tx,
      });

      return toSafeStockTransfer(created);
    });
  }

  async findOne(
    id: string,
    requesterRole: RoleName,
  ): Promise<SafeStockTransfer> {
    this.assertCanRead(requesterRole);
    const row = await this.prisma.stockTransfer.findUnique({
      where: { id },
      select: STOCK_TRANSFER_SAFE_SELECT,
    });
    if (row === null) {
      throw new NotFoundException('Transferencia no encontrada');
    }
    return toSafeStockTransfer(row);
  }

  async list(
    query: ListStockTransfersQuery,
    requesterRole: RoleName,
  ): Promise<PaginatedResult<SafeStockTransfer>> {
    this.assertCanRead(requesterRole);
    if (
      query.dateFrom !== undefined &&
      query.dateTo !== undefined &&
      query.dateFrom > query.dateTo
    ) {
      throw new BadRequestException('dateFrom no puede ser mayor que dateTo');
    }

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

    const where: Prisma.StockTransferWhereInput = {};
    if (query.productId !== undefined) where.productId = query.productId;
    if (query.sourceLocationId !== undefined) {
      where.sourceLocationId = query.sourceLocationId;
    }
    if (query.destinationLocationId !== undefined) {
      where.destinationLocationId = query.destinationLocationId;
    }
    if (query.warehouseId !== undefined) {
      where.OR = [
        { sourceLocation: { warehouseId: query.warehouseId } },
        { destinationLocation: { warehouseId: query.warehouseId } },
      ];
    }
    if (query.dateFrom !== undefined || query.dateTo !== undefined) {
      where.createdAt = {
        ...(query.dateFrom !== undefined ? { gte: query.dateFrom } : {}),
        ...(query.dateTo !== undefined ? { lte: query.dateTo } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.stockTransfer.findMany({
        where,
        select: STOCK_TRANSFER_SAFE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.stockTransfer.count({ where }),
    ]);

    return {
      data: rows.map(toSafeStockTransfer),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  // ------------------------------------------------------------------
  // Helpers privados
  // ------------------------------------------------------------------

  private assertCanRead(role: RoleName): void {
    if (!READ_ROLES.has(role)) {
      throw new ForbiddenException(
        'No tiene permisos para consultar transferencias de stock',
      );
    }
  }

  /** Representación canónica: UUID en minúsculas, cantidad a 3 decimales, textos recortados. */
  private normalize(input: CreateStockTransferInput): CanonicalTransfer {
    let quantity: Prisma.Decimal;
    try {
      quantity = new Prisma.Decimal(input.quantity);
    } catch {
      throw new BadRequestException('quantity no es un decimal válido');
    }
    if (!quantity.isFinite() || quantity.lessThanOrEqualTo(0)) {
      throw new BadRequestException('La cantidad debe ser mayor que cero');
    }
    if (quantity.decimalPlaces() > 3) {
      throw new BadRequestException(
        'La cantidad admite como máximo 3 decimales',
      );
    }

    const reason = (input.reason ?? '').trim();
    if (reason.length === 0) {
      throw new BadRequestException('El motivo no puede estar vacío');
    }
    if (reason.length > REASON_MAX_LENGTH) {
      throw new BadRequestException(
        'El motivo no puede superar los 200 caracteres',
      );
    }
    const trimmedNotes = input.notes?.trim() ?? '';
    if (trimmedNotes.length > NOTES_MAX_LENGTH) {
      throw new BadRequestException(
        'Las notas no pueden superar los 500 caracteres',
      );
    }

    const sourceLocationId = input.sourceLocationId.toLowerCase();
    const destinationLocationId = input.destinationLocationId.toLowerCase();
    if (sourceLocationId === destinationLocationId) {
      throw new BadRequestException(
        'La ubicación de origen y la de destino deben ser distintas',
      );
    }

    return {
      productId: input.productId.toLowerCase(),
      sourceLocationId,
      destinationLocationId,
      quantity: quantity.toFixed(3),
      reason,
      notes: trimmedNotes.length === 0 ? null : trimmedNotes,
    };
  }

  private normalizeIdempotencyKey(key: string | undefined): string | null {
    if (key === undefined) return null;
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException('idempotencyKey no puede estar vacía');
    }
    if (trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw new BadRequestException(
        'idempotencyKey no puede superar los 100 caracteres',
      );
    }
    return trimmed;
  }

  private sameContent(
    existing: StockTransferSafeRow,
    canonical: CanonicalTransfer,
  ): boolean {
    return (
      existing.product.id.toLowerCase() === canonical.productId &&
      existing.sourceLocation.id.toLowerCase() === canonical.sourceLocationId &&
      existing.destinationLocation.id.toLowerCase() ===
        canonical.destinationLocationId &&
      existing.quantity.toFixed(3) === canonical.quantity &&
      existing.reason === canonical.reason &&
      existing.notes === canonical.notes
    );
  }
}

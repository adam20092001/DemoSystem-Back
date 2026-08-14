import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditAction } from './audit-action.enum';

/**
 * Valores simples y no sensibles admitidos en metadata. Deliberadamente no
 * incluye `unknown`/`any`: cualquier estructura anidada arbitraria queda
 * fuera y debe aplanarse antes de auditar.
 */
export type AuditMetadataValue = string | number | boolean | null | string[];
export type AuditMetadata = Record<string, AuditMetadataValue>;

/** Cliente Prisma normal o cliente de transacción interactiva. */
export type PrismaExecutionClient = PrismaService | Prisma.TransactionClient;

export interface RecordAuditLogInput {
  userId: string | null;
  module: string;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  description: string;
  metadata?: AuditMetadata;
  ipAddress?: string | null;
  /** Cliente de la transacción en curso. Si se omite, se usa PrismaService. */
  client?: PrismaExecutionClient;
}

/**
 * Claves que jamás deben persistirse, sin importar la acción ni si el
 * llamador las incluyó por error dentro de metadata.
 */
const FORBIDDEN_METADATA_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'temporarypassword',
  'token',
  'jwt',
  'cookie',
  'authorization',
  'secret',
]);

/**
 * Lista blanca de metadata por acción. Una clave ausente de esta lista se
 * descarta aunque no sea sensible: el saneamiento es "permitir explícito",
 * no "bloquear conocido".
 */
const ALLOWED_METADATA_KEYS_BY_ACTION: Readonly<
  Record<AuditAction, readonly string[]>
> = {
  [AuditAction.LOGIN_SUCCESS]: ['username'],
  // El identifier ingresado por quien intenta iniciar sesión nunca se
  // audita: solo un motivo seguro (USER_NOT_FOUND, INVALID_PASSWORD, etc.).
  [AuditAction.LOGIN_FAILED]: ['reason'],
  [AuditAction.USER_CREATED]: ['username', 'email', 'roleName'],
  [AuditAction.USER_UPDATED]: ['updatedFields', 'roleName'],
  [AuditAction.USER_BLOCKED]: ['username'],
  [AuditAction.USER_UNBLOCKED]: ['username'],
  [AuditAction.PASSWORD_RESET]: ['username'],
  [AuditAction.PASSWORD_CHANGED]: ['username'],
  [AuditAction.CATEGORY_CREATED]: ['code', 'name', 'parentId'],
  [AuditAction.CATEGORY_UPDATED]: ['updatedFields'],
  [AuditAction.CATEGORY_ACTIVATED]: ['code'],
  [AuditAction.CATEGORY_DEACTIVATED]: ['code'],
  [AuditAction.UNIT_CREATED]: ['code', 'abbreviation', 'allowDecimal'],
  [AuditAction.UNIT_UPDATED]: ['updatedFields'],
  [AuditAction.UNIT_ACTIVATED]: ['code'],
  [AuditAction.UNIT_DEACTIVATED]: ['code'],
  [AuditAction.PRODUCT_CREATED]: ['sku', 'productType', 'categoryId', 'unitId'],
  [AuditAction.PRODUCT_UPDATED]: ['updatedFields'],
  [AuditAction.PRODUCT_PRICE_CHANGED]: ['oldPrice', 'newPrice'],
  [AuditAction.PRODUCT_ACTIVATED]: ['sku'],
  [AuditAction.PRODUCT_DEACTIVATED]: ['sku'],
  [AuditAction.PRODUCT_SPECIFICATION_CHANGED]: [
    'operation',
    'specificationName',
  ],
  [AuditAction.PRODUCT_IMAGE_ADDED]: [
    'imageId',
    'mimeType',
    'fileSize',
    'isPrimary',
  ],
  [AuditAction.PRODUCT_IMAGE_REMOVED]: ['imageId', 'wasPrimary'],
  [AuditAction.PRODUCT_PRIMARY_IMAGE_CHANGED]: [
    'previousImageId',
    'newImageId',
  ],
  // Las 5 acciones de inventario comparten la misma whitelist: nunca se
  // audita reason/notes/referenceType/referenceId. Decimal siempre como
  // string de 3 decimales (lo normaliza StockMovementEngine antes de llamar
  // a record()).
  [AuditAction.INVENTORY_INITIAL_BALANCE_CREATED]: [
    'movementId',
    'productId',
    'quantity',
    'previousStock',
    'newStock',
    'movementType',
    'origin',
  ],
  [AuditAction.INVENTORY_ENTRY_CREATED]: [
    'movementId',
    'productId',
    'quantity',
    'previousStock',
    'newStock',
    'movementType',
    'origin',
  ],
  [AuditAction.INVENTORY_EXIT_CREATED]: [
    'movementId',
    'productId',
    'quantity',
    'previousStock',
    'newStock',
    'movementType',
    'origin',
  ],
  [AuditAction.INVENTORY_ADJUSTMENT_IN_CREATED]: [
    'movementId',
    'productId',
    'quantity',
    'previousStock',
    'newStock',
    'movementType',
    'origin',
  ],
  [AuditAction.INVENTORY_ADJUSTMENT_OUT_CREATED]: [
    'movementId',
    'productId',
    'quantity',
    'previousStock',
    'newStock',
    'movementType',
    'origin',
  ],
  // Nunca se audita PII (documentNumber, name, tradeName, contactName,
  // email, phone, address, internalNotes): solo metadatos estructurales.
  [AuditAction.CUSTOMER_CREATED]: [
    'customerType',
    'customerStage',
    'documentType',
  ],
  [AuditAction.CUSTOMER_UPDATED]: ['updatedFields'],
  [AuditAction.CUSTOMER_ACTIVATED]: ['previousStatus'],
  [AuditAction.CUSTOMER_DEACTIVATED]: ['previousStatus'],
  [AuditAction.CUSTOMER_BLOCKED]: ['previousStatus'],
  [AuditAction.CUSTOMER_UNBLOCKED]: ['previousStatus'],
  [AuditAction.CUSTOMER_STAGE_CHANGED]: ['previousStage', 'customerStage'],
  // Nunca se audita PII de cliente (nombre/documento/dirección), payload de
  // ítems, nombres/SKU de producto ni ningún monto (subtotal/discount/tax/
  // total): la fila de Quote ya los conserva; el log solo necesita
  // trazabilidad estructural.
  [AuditAction.QUOTE_CREATED]: ['quoteNumber', 'customerId', 'itemCount'],
  [AuditAction.QUOTE_UPDATED]: ['quoteNumber', 'updatedFields', 'itemCount'],
  [AuditAction.QUOTE_ACCEPTED]: ['quoteNumber', 'previousStatus'],
  [AuditAction.QUOTE_REJECTED]: ['quoteNumber', 'previousStatus'],
  // Fase 6, Bloque B. La conversión registra QUOTE_CONVERTED (entityType
  // Quote) además de SALE_CONFIRMED (entityType Sale) en la misma
  // transacción; ninguna de las dos duplica montos ni PII.
  [AuditAction.QUOTE_CONVERTED]: ['quoteNumber', 'saleNumber'],
  // `source` distingue DIRECT de QUOTE; `quoteId` se omite por completo del
  // objeto de metadata en una venta directa (no se envía como null) para
  // que sanitizeAuditMetadata() nunca lo incluya. Nunca PII de cliente,
  // nombres/SKU de producto, ni ningún monto: la fila de Sale ya los
  // conserva.
  [AuditAction.SALE_CONFIRMED]: [
    'saleNumber',
    'source',
    'quoteId',
    'itemCount',
  ],
  // El motivo de anulación (texto libre) ya persiste en Sale.cancellationReason;
  // nunca se duplica en Audit.
  [AuditAction.SALE_CANCELLED]: ['saleNumber', 'previousStatus'],
  [AuditAction.SALE_DELIVERY_STATUS_CHANGED]: [
    'saleNumber',
    'previousDeliveryStatus',
    'deliveryStatus',
  ],
  // Fase 7, Bloque B. PaymentEngine es el único emisor de ambas (nunca
  // PaymentsService/SalesService). Nunca amount/reference (dato operativo/
  // potencialmente sensible ya persistido en Payment), nunca PII de
  // cliente, nunca cancellationReason (texto libre ya persistido en
  // Payment.cancellationReason), nunca totales de Sale.
  [AuditAction.PAYMENT_REGISTERED]: ['saleId', 'saleNumber', 'method'],
  [AuditAction.PAYMENT_CANCELLED]: [
    'saleId',
    'saleNumber',
    'previousStatus',
    'cancellationSource',
  ],
};

/**
 * Descarta cualquier clave no explícitamente permitida para la acción, y
 * como defensa adicional, cualquier clave que coincida con un nombre
 * sensible conocido, sea o no parte de la lista blanca. No muta `metadata`.
 */
export function sanitizeAuditMetadata(
  action: AuditAction,
  metadata?: AuditMetadata,
): AuditMetadata | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  const allowedKeys = ALLOWED_METADATA_KEYS_BY_ACTION[action];
  const sanitized: AuditMetadata = {};

  for (const key of Object.keys(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) {
      continue;
    }
    if (!allowedKeys.includes(key)) {
      continue;
    }
    sanitized[key] = metadata[key];
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra una entrada de auditoría. Acepta un cliente de transacción para
   * que el registro se confirme o revierta junto con la operación que audita.
   */
  async record(input: RecordAuditLogInput): Promise<void> {
    const client = input.client ?? this.prisma;
    const metadata = sanitizeAuditMetadata(input.action, input.metadata);

    await client.auditLog.create({
      data: {
        userId: input.userId,
        module: input.module,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        description: input.description,
        metadata: metadata,
        ipAddress: input.ipAddress ?? null,
      },
    });
  }
}

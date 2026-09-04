import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditAction } from './audit-action.enum';

/**
 * Escalar simple y no sensible: la única forma de valor admitida dentro de
 * un objeto anidado de metadata (ver AuditMetadataObject).
 */
export type AuditMetadataScalar = string | number | boolean | null;

/**
 * Objeto anidado de un solo nivel, exclusivamente de escalares. NUNCA
 * `unknown`/`any`/`Record<string, unknown>`: no admite un segundo nivel de
 * anidamiento, arrays de objetos, ni ninguna estructura arbitraria. Pensado
 * para pares oldValues/newValues (Fase 10, Bloque A) construidos siempre en
 * el servidor a partir de una whitelist explícita de campos conocidos —
 * nunca a partir del body de la petición sin filtrar.
 */
export type AuditMetadataObject = Readonly<Record<string, AuditMetadataScalar>>;

/**
 * Valores admitidos en metadata. Deliberadamente NO incluye `unknown`/`any`
 * ni un segundo nivel de anidamiento: cualquier estructura más profunda
 * queda fuera y debe aplanarse antes de auditar.
 */
export type AuditMetadataValue =
  AuditMetadataScalar | string[] | AuditMetadataObject;
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
  // KAN-18, Bloque A: roleName (singular) se reemplaza por roleNames (uno
  // o más). USER_UPDATED agrega addedRoles/removedRoles para el cambio de
  // roles asignados (reemplazo total) — solo nombres de rol, nunca Role.id,
  // token, JWT ni contraseña.
  [AuditAction.USER_CREATED]: ['username', 'email', 'roleNames'],
  [AuditAction.USER_UPDATED]: [
    'updatedFields',
    'roleNames',
    'addedRoles',
    'removedRoles',
  ],
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
  // Fase 8, Bloque B. AccountingEngine es el único emisor de ambas (nunca
  // SalesService/PaymentEngine). Nunca amount/debit/credit/lines (el asiento
  // y sus líneas ya son el registro persistido), nunca saleNumber/PII de
  // cliente/referencia de Payment/motivo de anulación/totales de Sale: solo
  // identificadores puros del asiento y de su evento origen.
  [AuditAction.ACCOUNTING_ENTRY_POSTED]: [
    'entryId',
    'sourceType',
    'sourceId',
    'eventType',
  ],
  [AuditAction.ACCOUNTING_ENTRY_REVERSED]: [
    'entryId',
    'sourceType',
    'sourceId',
    'eventType',
  ],
  // Fase 10, Bloque A. A diferencia de CATEGORY_UPDATED/UNIT_UPDATED/
  // CUSTOMER_UPDATED (solo `updatedFields`), CONFIGURATION_UPDATED sí
  // audita valores anterior/nuevo: ConfigurationService construye
  // oldValues/newValues en el servidor a partir de una whitelist cerrada de
  // los 8 campos editables del Bloque A (businessName/tradeName/taxId/
  // address/phone/email/currencyCode/currencySymbol) — nunca del body crudo
  // de la petición. changedFields acota además, a nivel del saneador (ver
  // sanitizeAuditMetadata), qué claves pueden aparecer dentro de
  // oldValues/newValues: cualquier clave que no figure en changedFields se
  // descarta aunque el llamador la hubiera incluido por error. singleton/
  // id/createdAt/updatedAt y los campos aún bloqueados del Bloque A
  // (taxEnabled/taxRate/quoteValidityDays/maxDiscountPercent) nunca
  // aparecen: ConfigurationService no los declara como editables en este
  // bloque.
  [AuditAction.CONFIGURATION_UPDATED]: [
    'changedFields',
    'oldValues',
    'newValues',
  ],
  // Fase 10, Bloque D. Mismo contrato que CONFIGURATION_UPDATED
  // (changedFields + oldValues/newValues acotados a los campos realmente
  // cambiados), más `documentType` como campo plano — permite identificar
  // QUOTE/SALE sin depender de entityId. Los únicos campos editables son
  // prefix/padding/currentNumber; nunca se audita id/updatedAt ni el valor
  // "próximo" que emitiría next().
  [AuditAction.SEQUENCE_UPDATED]: [
    'documentType',
    'changedFields',
    'oldValues',
    'newValues',
  ],
  // KAN-18, Bloque B. Evento de sesión, no de administración de usuarios:
  // solo los dos RoleName involucrados, nunca roleId, JWT, cookie ni el
  // cuerpo de la petición.
  [AuditAction.ACTIVE_ROLE_SWITCHED]: ['fromRole', 'toRole'],
  // Fase 11, Bloque C. ElectronicDocumentsService es el único emisor de las
  // 4. Nunca credenciales/secretos de proveedor, nunca el request/response
  // crudo, nunca stack trace, nunca providerMessage completo (puede
  // contener texto libre del proveedor): solo identidad estructural del
  // documento y, en las 3 de resultado, el providerStatus ya saneado.
  [AuditAction.ELECTRONIC_DOCUMENT_CREATED]: [
    'documentType',
    'series',
    'number',
    'saleNumber',
    'providerCode',
  ],
  [AuditAction.ELECTRONIC_DOCUMENT_ACCEPTED]: [
    'documentType',
    'series',
    'number',
    'saleNumber',
    'providerCode',
    'providerStatus',
  ],
  [AuditAction.ELECTRONIC_DOCUMENT_REJECTED]: [
    'documentType',
    'series',
    'number',
    'saleNumber',
    'providerCode',
    'providerStatus',
  ],
  [AuditAction.ELECTRONIC_DOCUMENT_SUBMISSION_FAILED]: [
    'documentType',
    'series',
    'number',
    'saleNumber',
    'providerCode',
    'providerStatus',
  ],
  // Ticket C post-MVP, Bloque C2. PaymentMethodsService es el único emisor
  // de las 4. CREATED audita los valores de creación planos (el método
  // nace `active: true`, así que `active` nunca aparece aquí). UPDATED/
  // ACTIVATED/DEACTIVATED comparten el MISMO contrato que
  // CONFIGURATION_UPDATED (changedFields + oldValues/newValues acotados a
  // los campos realmente cambiados), más `code` como campo plano — permite
  // identificar el método sin depender de entityId. Un PATCH cuyo `active`
  // transiciona emite SOLO ACTIVATED/DEACTIVATED aunque otros campos hayan
  // cambiado en la misma petición (viajan dentro de changedFields/
  // oldValues/newValues de esa misma fila): nunca una fila UPDATED
  // adicional para la misma petición.
  [AuditAction.PAYMENT_METHOD_CREATED]: [
    'code',
    'name',
    'requiresReference',
    'affectsCashDrawer',
    'accountingDestination',
    'sortOrder',
  ],
  [AuditAction.PAYMENT_METHOD_UPDATED]: [
    'code',
    'changedFields',
    'oldValues',
    'newValues',
  ],
  [AuditAction.PAYMENT_METHOD_ACTIVATED]: [
    'code',
    'changedFields',
    'oldValues',
    'newValues',
  ],
  [AuditAction.PAYMENT_METHOD_DEACTIVATED]: [
    'code',
    'changedFields',
    'oldValues',
    'newValues',
  ],
  // Ticket B post-MVP, Bloque B2. CashSessionsService.open() es su único
  // emisor. Solo campos seguros y ya conocidos por el actor que abrió la
  // caja: nunca el actor completo, la request cruda, el JWT ni nada
  // sensible.
  [AuditAction.CASH_SESSION_OPENED]: [
    'cashSessionId',
    'userId',
    'openingAmount',
  ],
  // Ticket B post-MVP, Bloque B3. CashSessionsService.close() es su único
  // emisor para estas dos primeras. Nunca el actor completo/IP cruda: eso
  // ya lo registra RecordAuditLogInput.ipAddress por separado.
  [AuditAction.CASH_SESSION_CLOSED]: [
    'cashSessionId',
    'userId',
    'expectedCashAmount',
    'countedCashAmount',
    'differenceAmount',
  ],
  [AuditAction.CASH_SESSION_CLOSING_REQUESTED]: [
    'cashSessionId',
    'userId',
    'expectedCashAmount',
    'countedCashAmount',
    'differenceAmount',
    'closingObservation',
  ],
  // CashSessionsService.approve()/reject() son sus únicos emisores.
  // ownerUserId (dueño de la caja) y reviewerUserId (quien aprueba/
  // rechaza) SIEMPRE son personas distintas — la propia autorización lo
  // exige antes de llegar aquí.
  [AuditAction.CASH_SESSION_DISCREPANCY_APPROVED]: [
    'cashSessionId',
    'ownerUserId',
    'reviewerUserId',
    'expectedCashAmount',
    'countedCashAmount',
    'differenceAmount',
    'comment',
  ],
  // Único emisor de reject(): captura el snapshot PREVIO a limpiarlo de
  // CashSession (Ticket B, Bloque B3 §20) — esta fila es la única
  // evidencia histórica que sobrevive de ese intento de cierre rechazado.
  [AuditAction.CASH_SESSION_DISCREPANCY_REJECTED]: [
    'cashSessionId',
    'ownerUserId',
    'reviewerUserId',
    'reason',
    'previousExpectedCashAmount',
    'previousCountedCashAmount',
    'previousDifferenceAmount',
    'previousClosingObservation',
  ],
};

function isPlainObject(
  value: AuditMetadataValue,
): value is AuditMetadataObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuditScalar(value: unknown): value is AuditMetadataScalar {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  );
}

/**
 * Sanea un valor-objeto anidado (p. ej. oldValues/newValues): descarta
 * cualquier clave con nombre sensible conocido, cualquier valor que no sea
 * un escalar (nunca arrays, nunca un segundo nivel de anidamiento), y —
 * defensa de última línea, independiente de lo que haya construido el
 * llamador — cualquier clave que no figure en `scopeKeys` cuando este se
 * provee. No muta `value`.
 */
function sanitizeNestedObject(
  value: AuditMetadataObject,
  scopeKeys: readonly string[] | undefined,
): AuditMetadataObject {
  const sanitized: Record<string, AuditMetadataScalar> = {};
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) {
      continue;
    }
    if (scopeKeys !== undefined && !scopeKeys.includes(key)) {
      continue;
    }
    const nestedValue: unknown = value[key];
    if (isAuditScalar(nestedValue)) {
      sanitized[key] = nestedValue;
    }
  }
  return sanitized;
}

/**
 * Descarta cualquier clave no explícitamente permitida para la acción, y
 * como defensa adicional, cualquier clave que coincida con un nombre
 * sensible conocido, sea o no parte de la lista blanca. No muta `metadata`.
 *
 * Cuando el valor de una clave permitida es un objeto anidado (p. ej.
 * oldValues/newValues, Fase 10), se sanea recursivamente con
 * sanitizeNestedObject(): si `changedFields` está presente en el mismo
 * payload como string[], acota además qué claves pueden sobrevivir dentro
 * de ESE objeto anidado — así ninguna acción futura que reutilice este
 * mismo patrón (changedFields + oldValues/newValues) puede filtrar un campo
 * no declarado como realmente cambiado, sin importar qué construyó el
 * llamador.
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

  const changedFieldsRaw = metadata.changedFields;
  const changedFields = Array.isArray(changedFieldsRaw)
    ? changedFieldsRaw
    : undefined;

  for (const key of Object.keys(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) {
      continue;
    }
    if (!allowedKeys.includes(key)) {
      continue;
    }
    const value = metadata[key];
    sanitized[key] = isPlainObject(value)
      ? sanitizeNestedObject(value, changedFields)
      : value;
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

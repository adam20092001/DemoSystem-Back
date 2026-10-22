import {
  AccountingSystemKey,
  InventoryValuationEventType,
  InventoryValuationSourceType,
  Prisma,
  PurchasePurpose,
} from '@prisma/client';
import { PURCHASE_PURPOSE_TO_SYSTEM_KEY } from '../purchase-invoices/purchase-invoice-calculator';

export interface CogsAccountResolution {
  accountId: string;
}

interface CachedSourceAccount {
  id: string;
  receiptReclassificationTargetAccountId: string | null;
}

/**
 * Resuelve la ÚNICA cuenta histórica de inventario que respalda el pool
 * ACTIVO de valorización de un producto (Fase A6.2), para el crédito del
 * asiento de COGS — nunca el mapeo VIGENTE de PURCHASE_RESALE_INVENTORY por
 * sí solo, siempre verificado contra lo que el asiento PURCHASE original de
 * cada factura REALMENTE debitó (mismo criterio exacto que
 * PurchaseReceiptsService.resolveReclassificationPlan()). Retorna null
 * (bloquear 409, nunca adivinar) cuando: no hay ninguna capa activa (sin
 * historial de valorización todavía), cualquier capa activa se reconoció
 * con un propósito distinto de RESALE_INVENTORY (CLAUDE.md A6.2 §5: "una
 * compra reconocida directamente como gasto no debe generar un segundo
 * gasto COGS"), cualquier capa no puede verificarse contra su asiento
 * histórico real, o las capas activas resuelven a más de una cuenta
 * distinta.
 *
 * "Capa activa" = evento ORIGINAL de sourceType=PURCHASE_RECEIPT que nunca
 * fue revertido (reversedByValuation null): una capa totalmente revertida
 * ya no aporta valor al pool vigente, así que su propósito/cuenta histórica
 * no puede volver este producto incompatible con COGS.
 */
export async function resolveHistoricalInventoryAccountForProduct(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<CogsAccountResolution | null> {
  const activeLayers = await tx.inventoryValuation.findMany({
    where: {
      productId,
      sourceType: InventoryValuationSourceType.PURCHASE_RECEIPT,
      eventType: InventoryValuationEventType.ORIGINAL,
      reversedByValuation: null,
    },
    select: {
      purchaseReceiptLine: {
        select: {
          reclassifiedAmount: true,
          purchaseReceipt: { select: { reclassificationEntryId: true } },
          purchaseInvoiceLine: {
            select: {
              purchasePurpose: true,
              purchaseInvoice: { select: { postedEntryId: true } },
            },
          },
        },
      },
    },
  });

  if (activeLayers.length === 0) {
    return null;
  }

  const resolvedAccountIds = new Set<string>();
  const sourceAccountCache = new Map<
    AccountingSystemKey,
    CachedSourceAccount | null
  >();

  for (const layer of activeLayers) {
    const line = layer.purchaseReceiptLine;
    if (line === null) {
      // Invariante de BD roto (purchase_receipt_line_id es obligatorio para
      // sourceType=PURCHASE_RECEIPT) — tratado como ambiguo, nunca 500 aquí.
      return null;
    }
    if (
      line.purchaseInvoiceLine.purchasePurpose !==
      PurchasePurpose.RESALE_INVENTORY
    ) {
      return null;
    }

    const systemKey =
      PURCHASE_PURPOSE_TO_SYSTEM_KEY[PurchasePurpose.RESALE_INVENTORY];
    let sourceAccount = sourceAccountCache.get(systemKey);
    if (sourceAccount === undefined) {
      const row = await tx.account.findFirst({ where: { systemKey } });
      sourceAccount =
        row === null
          ? null
          : {
              id: row.id,
              receiptReclassificationTargetAccountId:
                row.receiptReclassificationTargetAccountId,
            };
      sourceAccountCache.set(systemKey, sourceAccount);
    }
    if (sourceAccount === null) {
      return null;
    }

    const postedEntryId =
      line.purchaseInvoiceLine.purchaseInvoice.postedEntryId;
    if (postedEntryId === null) {
      return null;
    }
    const originalDebitLines = await tx.accountingEntryLine.findMany({
      where: { entryId: postedEntryId, debitAmount: { gt: 0 } },
      select: { accountId: true },
    });
    if (!originalDebitLines.some((l) => l.accountId === sourceAccount.id)) {
      // El mapeo vigente de PURCHASE_RESALE_INVENTORY cambió desde que esta
      // factura se confirmó: no se puede verificar con seguridad.
      return null;
    }

    const reclassificationEntryId =
      line.purchaseReceipt.reclassificationEntryId;
    const wasReclassified =
      reclassificationEntryId !== null &&
      line.reclassifiedAmount !== null &&
      line.reclassifiedAmount.greaterThan(0);

    let effectiveAccountId = sourceAccount.id;
    if (wasReclassified) {
      const targetAccountId =
        sourceAccount.receiptReclassificationTargetAccountId;
      if (targetAccountId === null) {
        return null;
      }
      const reclassificationDebitLines = await tx.accountingEntryLine.findMany({
        where: { entryId: reclassificationEntryId, debitAmount: { gt: 0 } },
        select: { accountId: true },
      });
      if (
        !reclassificationDebitLines.some((l) => l.accountId === targetAccountId)
      ) {
        return null;
      }
      effectiveAccountId = targetAccountId;
    }

    resolvedAccountIds.add(effectiveAccountId);
    if (resolvedAccountIds.size > 1) {
      return null;
    }
  }

  const [accountId] = resolvedAccountIds;
  return accountId === undefined ? null : { accountId };
}

import { PrismaClient } from '@prisma/client';

/**
 * Retira, al terminar una suite E2E, TODO el residuo financiero y documental de
 * Compras/Importaciones que ella misma creó (proveedores por prefijo de razón
 * social, cuentas contables por prefijo de código), para no dejar en la base
 * compartida datos que rompen otras suites (conteo de cuentas, regla A0.2 de
 * cambio de moneda por existencia de asientos, páginas del Libro Diario, etc.).
 *
 * Orden: dependientes primero (vínculos/gastos/embarques/operaciones, pagos,
 * valorización, recepciones, facturas) y luego asientos y cuentas. Solo escribe
 * en la base descartable verificada por la guardia (createTestPrismaClient).
 */
export async function purgePurchasingResidue(
  prisma: PrismaClient,
  input: {
    supplierLegalNamePrefix: string;
    accountCodePrefixes: string[];
    importOperationReferencePrefixes?: string[];
  },
): Promise<void> {
  const suppliers = await prisma.supplier.findMany({
    where: { legalName: { startsWith: input.supplierLegalNamePrefix } },
    select: { id: true },
  });
  const supplierIds = suppliers.map((s) => s.id);
  const invoices = await prisma.purchaseInvoice.findMany({
    where: { supplierId: { in: supplierIds } },
    select: { id: true },
  });
  const invoiceIds = invoices.map((i) => i.id);
  const payments = await prisma.supplierPayment.findMany({
    where: { supplierId: { in: supplierIds } },
    select: { id: true },
  });
  const paymentIds = payments.map((p) => p.id);
  const receipts = await prisma.purchaseReceipt.findMany({
    where: { purchaseInvoiceId: { in: invoiceIds } },
    select: { id: true },
  });
  const receiptIds = receipts.map((r) => r.id);
  const receiptLines = await prisma.purchaseReceiptLine.findMany({
    where: { purchaseReceiptId: { in: receiptIds } },
    select: { id: true },
  });
  const receiptLineIds = receiptLines.map((l) => l.id);

  // --- Importaciones (operaciones vinculadas a estas facturas o con referencia de fixture)
  const operations = await prisma.importOperation.findMany({
    where: {
      OR: [
        { purchaseInvoiceId: { in: invoiceIds } },
        ...(input.importOperationReferencePrefixes ?? []).map((prefix) => ({
          reference: { startsWith: prefix },
        })),
      ],
    },
    select: { id: true },
  });
  const operationIds = operations.map((o) => o.id);
  const shipments = await prisma.importShipment.findMany({
    where: { importOperationId: { in: operationIds } },
    select: { id: true },
  });
  const shipmentLines = await prisma.importShipmentLine.findMany({
    where: { importShipmentId: { in: shipments.map((s) => s.id) } },
    select: { id: true },
  });
  const shipmentLineIds = shipmentLines.map((l) => l.id);
  const expenses = await prisma.importExpense.findMany({
    where: { importOperationId: { in: operationIds } },
    select: { id: true },
  });
  const expenseIds = expenses.map((e) => e.id);

  await prisma.importReceiptLink.deleteMany({
    where: {
      OR: [
        { importShipmentLineId: { in: shipmentLineIds } },
        { purchaseReceiptLineId: { in: receiptLineIds } },
      ],
    },
  });
  const batches = await prisma.importExpenseAllocationBatch.findMany({
    where: { importExpenseId: { in: expenseIds } },
    select: { id: true },
  });
  await prisma.importExpenseAllocation.deleteMany({
    where: {
      OR: [
        { importShipmentLineId: { in: shipmentLineIds } },
        { batchId: { in: batches.map((b) => b.id) } },
      ],
    },
  });
  await prisma.importExpenseAllocationBatch.deleteMany({
    where: { importExpenseId: { in: expenseIds } },
  });
  await prisma.importExpense.deleteMany({ where: { id: { in: expenseIds } } });
  await prisma.importShipmentLine.deleteMany({
    where: { id: { in: shipmentLineIds } },
  });
  await prisma.importShipment.deleteMany({
    where: { id: { in: shipments.map((s) => s.id) } },
  });
  await prisma.importOperation.deleteMany({
    where: { id: { in: operationIds } },
  });

  // --- Pagos y asignaciones
  await prisma.supplierPaymentAllocation.deleteMany({
    where: { supplierPaymentId: { in: paymentIds } },
  });
  const paymentEntryIds = (
    await prisma.supplierPayment.findMany({
      where: { id: { in: paymentIds } },
      select: { postedEntryId: true },
    })
  ).map((p) => p.postedEntryId);
  await prisma.supplierPayment.deleteMany({
    where: { id: { in: paymentIds } },
  });

  // --- Valorización (reversas primero) y recepciones
  await prisma.inventoryValuation.deleteMany({
    where: {
      purchaseReceiptLineId: { in: receiptLineIds },
      reversesValuationId: { not: null },
    },
  });
  await prisma.inventoryValuation.deleteMany({
    where: { purchaseReceiptLineId: { in: receiptLineIds } },
  });
  const receiptEntryIds = (
    await prisma.purchaseReceipt.findMany({
      where: { id: { in: receiptIds } },
      select: { reclassificationEntryId: true },
    })
  )
    .map((r) => r.reclassificationEntryId)
    .filter((id): id is string => id !== null);
  await prisma.purchaseReceiptLine.deleteMany({
    where: { id: { in: receiptLineIds } },
  });
  await prisma.purchaseReceipt.deleteMany({
    where: { id: { in: receiptIds } },
  });

  // --- Facturas (sus líneas caen en cascada)
  const invoiceEntryIds = (
    await prisma.purchaseInvoice.findMany({
      where: { id: { in: invoiceIds } },
      select: { postedEntryId: true },
    })
  )
    .map((i) => i.postedEntryId)
    .filter((id): id is string => id !== null);
  await prisma.purchaseInvoice.deleteMany({
    where: { id: { in: invoiceIds } },
  });

  // --- Asientos propios (originales y reversas) y sus líneas
  const accounts = await prisma.account.findMany({
    where: {
      OR: input.accountCodePrefixes.map((prefix) => ({
        code: { startsWith: prefix },
      })),
    },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  const touching = await prisma.accountingEntryLine.findMany({
    where: { accountId: { in: accountIds } },
    select: { entryId: true },
  });
  const baseEntryIds = Array.from(
    new Set([
      ...invoiceEntryIds,
      ...paymentEntryIds,
      ...receiptEntryIds,
      ...touching.map((l) => l.entryId),
    ]),
  );
  const bySource = await prisma.accountingEntry.findMany({
    where: { sourceId: { in: [...invoiceIds, ...paymentIds, ...receiptIds] } },
    select: { id: true },
  });
  const allBase = Array.from(
    new Set([...baseEntryIds, ...bySource.map((e) => e.id)]),
  );
  const reversals = await prisma.accountingEntry.findMany({
    where: { reversesEntryId: { in: allBase } },
    select: { id: true },
  });
  const entryIds = Array.from(
    new Set([...allBase, ...reversals.map((e) => e.id)]),
  );
  await prisma.accountingEntryLine.deleteMany({
    where: { entryId: { in: entryIds } },
  });
  await prisma.accountingEntry.deleteMany({ where: { id: { in: entryIds } } });

  // --- Cuentas de fixture (se liberan sus systemKey antes) y proveedores
  await prisma.account.updateMany({
    where: { id: { in: accountIds } },
    data: { systemKey: null },
  });
  await prisma.account.updateMany({
    where: { receiptReclassificationTargetAccountId: { in: accountIds } },
    data: { receiptReclassificationTargetAccountId: null },
  });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.supplier.deleteMany({ where: { id: { in: supplierIds } } });
}

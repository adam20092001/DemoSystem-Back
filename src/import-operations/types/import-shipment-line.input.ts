/**
 * Línea de contenido de embarque, TAL CUAL llega del DTO (decimales como
 * texto, sin parsear todavía) — usada tanto por
 * ImportShipmentsService.create() como por ImportShipmentsService.update()
 * (reemplazo completo del arreglo, mismo criterio que
 * PurchaseInvoiceLine/ManualJournalDraftLine). El servicio parsea/valida
 * cada decimal, mismo criterio exacto que CreatePurchaseInvoiceInput.
 */
export interface ImportShipmentLineInput {
  productId?: string;
  descriptionSnapshot?: string;
  plannedQuantity: string;
  unitCode?: string;
  unitName?: string;
  weightValue?: string;
  weightUnit?: string;
  volumeValue?: string;
  volumeUnit?: string;
  purchaseInvoiceLineId?: string;
}

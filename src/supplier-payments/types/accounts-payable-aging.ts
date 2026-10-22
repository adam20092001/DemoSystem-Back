import { AgingBucket } from '../accounts-payable-calculator';

export interface AgingBucketAmount {
  bucket: AgingBucket;
  invoiceCount: number;
  amount: string;
  /** Porcentaje de `amount` sobre el saldo pendiente total de su mismo nivel (proveedor o general). */
  percentage: string;
}

export interface AgingBySupplier {
  supplierId: string;
  supplierLegalName: string;
  supplierDocumentNumber: string;
  totalPending: string;
  buckets: AgingBucketAmount[];
}

/**
 * Antigüedad de deuda (Fase A5.4), SIEMPRE calculada sobre el saldo
 * VIGENTE a `asOfDate` (la fecha de negocio actual) — nunca un saldo
 * histórico reconstruido a una fecha de corte pasada: los datos de pagos/
 * anulaciones no garantizan esa reconstrucción fiel (ver
 * `limitations`), así que este reporte deliberadamente no la ofrece.
 */
export interface AgingReport {
  asOfDate: string;
  totals: {
    totalPending: string;
    buckets: AgingBucketAmount[];
  };
  bySupplier: AgingBySupplier[];
  limitations: string[];
}

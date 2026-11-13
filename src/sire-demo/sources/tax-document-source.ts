import { RawTaxDocument, SireRegister, SireSource } from '../core/types';

export interface PeriodCount {
  period: string;
  documentCount: number;
}

export interface SourceLoadResult {
  /** Solo documentos elegibles (ElectronicDocument ACCEPTED / PurchaseInvoice CONFIRMED). */
  documents: RawTaxDocument[];
  excluded: {
    /** Documentos del periodo que existen pero no son elegibles por su estado. */
    notEligibleStatus: number;
    /** Solo origen POS + RVIE: ventas activas del periodo sin ningún comprobante fiscal. null si no aplica. */
    salesWithoutFiscalDocument: number | null;
  };
}

/** Estados elegibles, compartidos por AMBOS orígenes para que no puedan divergir. */
export const RVIE_ELIGIBLE_STATUS = 'ACCEPTED' as const;
export const RCE_ELIGIBLE_STATUS = 'CONFIRMED' as const;

/**
 * Fuente de documentos crudos. Dos implementaciones, claramente separadas:
 * POS (solo lectura sobre Prisma) y DEMO_FIXTURES (sin acceso a base de datos).
 */
export interface TaxDocumentSource {
  readonly source: SireSource;
  listPeriods(register: SireRegister): Promise<PeriodCount[]>;
  load(register: SireRegister, period: string): Promise<SourceLoadResult>;
}

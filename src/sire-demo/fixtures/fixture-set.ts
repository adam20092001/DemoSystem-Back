import { createHash } from 'node:crypto';
import { RawRceDocument, RawRvieDocument, SireRegister } from '../core/types';

/** Conjunto de fixtures inmutable y versionado (Addendum §3). */
export interface FixtureSet {
  version: string;
  /** SHA-256 del contenido canónico; una prueba lo recalcula y lo compara. */
  digest: string;
  periods: Record<SireRegister, string[]>;
  documents: { RVIE: RawRvieDocument[]; RCE: RawRceDocument[] };
  /** Archivo DEMO_V1 versionado por registro (propuesta independiente del lado POS). */
  sampleFiles: Record<SireRegister, { period: string; content: string }>;
}

function canonicalRvie(doc: RawRvieDocument): string[] {
  return [
    doc.refId,
    doc.documentType,
    doc.series,
    String(doc.number),
    doc.status,
    doc.providerCode,
    doc.issuedAt.toISOString(),
    doc.currencyCode,
    doc.customerDocumentType ?? '',
    doc.customerDocumentNumber ?? '',
    doc.customerName,
    doc.taxableBase.toFixed(2),
    doc.taxAmount.toFixed(2),
    doc.total.toFixed(2),
  ];
}

function canonicalRce(doc: RawRceDocument): string[] {
  return [
    doc.refId,
    doc.documentType,
    doc.documentSeries ?? '',
    doc.documentNumber,
    doc.status,
    doc.issueDate.toISOString(),
    doc.accountingDate.toISOString(),
    doc.currencyCode,
    doc.supplierDocumentType,
    doc.supplierDocumentNumber,
    doc.supplierLegalName,
    doc.subtotal.toFixed(2),
    doc.taxAmount.toFixed(2),
    doc.totalAmount.toFixed(2),
  ];
}

/** Digest determinista del contenido (versión, periodos, documentos y archivos). */
export function computeFixtureSetDigest(set: FixtureSet): string {
  const hash = createHash('sha256');
  const feed = (line: string): void => {
    hash.update(`${line}\n`);
  };
  feed(`version=${set.version}`);
  feed(`periods.RVIE=${set.periods.RVIE.join(',')}`);
  feed(`periods.RCE=${set.periods.RCE.join(',')}`);
  set.documents.RVIE.forEach((doc) =>
    feed(`RVIE|${canonicalRvie(doc).join('|')}`),
  );
  set.documents.RCE.forEach((doc) =>
    feed(`RCE|${canonicalRce(doc).join('|')}`),
  );
  feed(
    `sample.RVIE=${set.sampleFiles.RVIE.period}\n${set.sampleFiles.RVIE.content}`,
  );
  feed(
    `sample.RCE=${set.sampleFiles.RCE.period}\n${set.sampleFiles.RCE.content}`,
  );
  return hash.digest('hex');
}

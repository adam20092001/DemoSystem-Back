import { Injectable } from '@nestjs/common';
import { rcePeriodOf, rviePeriodOf } from '../core/period';
import { RawTaxDocument, SireRegister } from '../core/types';
import {
  CURRENT_FIXTURE_SET,
  getFixtureSet,
} from '../fixtures/fixture-registry';
import {
  PeriodCount,
  RCE_ELIGIBLE_STATUS,
  RVIE_ELIGIBLE_STATUS,
  SourceLoadResult,
  TaxDocumentSource,
} from './tax-document-source';

function periodOf(doc: RawTaxDocument): string {
  return doc.register === 'RVIE'
    ? rviePeriodOf(doc.issuedAt)
    : rcePeriodOf(doc.accountingDate);
}

function eligibleStatusOf(register: SireRegister): string {
  return register === 'RVIE' ? RVIE_ELIGIBLE_STATUS : RCE_ELIGIBLE_STATUS;
}

/**
 * Origen DEMO_FIXTURES: documentos sintéticos versionados, en memoria.
 *
 * Garantía ESTRUCTURAL de aislamiento: esta clase NO recibe ningún cliente de
 * base de datos (constructor sin parámetros), así que no puede leer ni
 * escribir ventas, compras, inventario ni contabilidad.
 */
@Injectable()
export class FixtureTaxDocumentSource implements TaxDocumentSource {
  readonly source = 'DEMO_FIXTURES' as const;

  listPeriods(register: SireRegister): Promise<PeriodCount[]> {
    const docs: RawTaxDocument[] = CURRENT_FIXTURE_SET.documents[register];
    const status = eligibleStatusOf(register);
    const counts = new Map<string, number>();
    for (const doc of docs) {
      if (doc.status === status) {
        const period = periodOf(doc);
        counts.set(period, (counts.get(period) ?? 0) + 1);
      }
    }
    return Promise.resolve(
      [...counts.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([period, documentCount]) => ({ period, documentCount })),
    );
  }

  /**
   * `fixtureSetVersion` permite a S3 conciliar una propuesta contra SU
   * versión; una versión desconocida RECHAZA (nunca recurre a otra).
   */
  load(
    register: SireRegister,
    period: string,
    fixtureSetVersion: string = CURRENT_FIXTURE_SET.version,
  ): Promise<SourceLoadResult> {
    const set = getFixtureSet(fixtureSetVersion);
    if (set === undefined) {
      return Promise.reject(
        new Error(`Versión de fixtures no disponible: ${fixtureSetVersion}`),
      );
    }
    const all: RawTaxDocument[] = set.documents[register];
    const inPeriod = all.filter((doc) => periodOf(doc) === period);
    const status = eligibleStatusOf(register);
    const documents = inPeriod.filter((doc) => doc.status === status);
    return Promise.resolve({
      documents,
      excluded: {
        notEligibleStatus: inPeriod.length - documents.length,
        salesWithoutFiscalDocument: null,
      },
    });
  }
}

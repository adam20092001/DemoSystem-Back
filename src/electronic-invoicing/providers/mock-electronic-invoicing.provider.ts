import { Injectable } from '@nestjs/common';
import { MOCK_PROVIDER_CODE } from '../constants/electronic-invoicing.constants';
import {
  ElectronicDocumentSubmissionPayload,
  ElectronicInvoicingProvider,
  ProviderSubmissionResult,
} from './electronic-invoicing-provider.interface';

/**
 * Proveedor de demostración (Bloque 11C §22): SIEMPRE devuelve un resultado
 * determinístico ACCEPTED. Sin Math.random, sin ramas basadas en Date.now,
 * sin "RUC mágico" ni "monto mágico" que fuercen un rechazo — cualquier
 * comportamiento de prueba (REJECTED, fallo técnico) se logra sustituyendo
 * este proveedor por un doble de prueba vía ELECTRONIC_INVOICING_PROVIDER
 * (override de módulo de testing de Nest), nunca contaminando esta clase
 * con interruptores exclusivos de pruebas (§23).
 */
@Injectable()
export class MockElectronicInvoicingProvider implements ElectronicInvoicingProvider {
  readonly code = MOCK_PROVIDER_CODE;

  submit(
    payload: ElectronicDocumentSubmissionPayload,
  ): Promise<ProviderSubmissionResult> {
    return Promise.resolve({
      outcome: 'ACCEPTED',
      externalId: `MOCK-${payload.documentId}`,
      providerStatus: 'ACCEPTED',
      providerMessage:
        'Documento aceptado por el proveedor de demostración (MOCK).',
    });
  }
}

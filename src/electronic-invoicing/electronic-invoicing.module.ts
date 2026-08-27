import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ElectronicInvoicingProviderCode,
  EnvironmentVariables,
} from '../config/env.validation';
import { ElectronicDocumentsService } from './electronic-documents.service';
import { FiscalSeriesService } from './fiscal-series.service';
import { MockElectronicInvoicingProvider } from './providers/mock-electronic-invoicing.provider';
import { ELECTRONIC_INVOICING_PROVIDER } from './providers/electronic-invoicing-provider.token';

/**
 * Módulo de facturación electrónica (Fase 11, Bloque C). Deliberadamente
 * SIN controllers: no existe API pública en este bloque (Fase 11D). Solo
 * componentes internos, consumibles por un futuro controller o por otro
 * módulo que decida importar ElectronicInvoicingModule explícitamente —
 * SalesModule/PaymentsModule/AccountingModule/CustomersModule/ReportsModule
 * NO lo importan (ninguna dependencia inversa: la emisión fiscal consume a
 * Sale, nunca al revés).
 *
 * PrismaService y AuditService llegan de módulos globales (Database,
 * Audit): no se importan explícitamente aquí. SettingsReader
 * (Configuración) NO se usa: la identidad del emisor se lee directamente de
 * CompanySettings dentro de ElectronicDocumentsService (ese puerto expone
 * deliberadamente solo moneda/IGV/vigencia/descuento, nunca identidad de
 * empresa), y el contexto de moneda/impuesto del documento se copia
 * siempre del snapshot ya congelado de Sale, nunca de una lectura vigente.
 */
@Module({
  providers: [
    ElectronicDocumentsService,
    FiscalSeriesService,
    MockElectronicInvoicingProvider,
    {
      provide: ELECTRONIC_INVOICING_PROVIDER,
      useFactory: (
        config: ConfigService<EnvironmentVariables, true>,
        mock: MockElectronicInvoicingProvider,
      ) => {
        const selected = config.get('ELECTRONIC_INVOICING_PROVIDER', {
          infer: true,
        });
        switch (selected) {
          case ElectronicInvoicingProviderCode.Mock:
            return mock;
          // env.validation ya restringe ELECTRONIC_INVOICING_PROVIDER a los
          // valores de ElectronicInvoicingProviderCode: esta rama es una
          // defensa adicional, nunca alcanzable con un arranque válido (sin
          // configuración específica de proveedor real en este bloque).
          default:
            throw new Error(
              `Proveedor de facturación electrónica no soportado: ${String(selected)}`,
            );
        }
      },
      inject: [ConfigService, MockElectronicInvoicingProvider],
    },
  ],
  exports: [ElectronicDocumentsService, FiscalSeriesService],
})
export class ElectronicInvoicingModule {}

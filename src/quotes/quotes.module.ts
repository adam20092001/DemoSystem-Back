import { Module } from '@nestjs/common';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DocumentSequencesModule } from '../document-sequences/document-sequences.module';
import { QuoteDocumentRenderer } from './printing/quote-document.renderer';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';

/**
 * PrismaService y AuditService llegan de módulos globales (Database, Audit).
 * DocumentSequencesModule se importa aquí (encapsulado): AppModule no
 * necesita registrarlo por separado. Se exporta QuotesService para que la
 * futura Fase 6 (Ventas) pueda componerlo dentro de su propia transacción.
 *
 * ConfigurationModule (Fase 10, Bloque B): QuotesService inyecta únicamente
 * SettingsReader (el puerto de lectura estrecho que ConfigurationModule
 * exporta) para la vigencia por defecto y el descuento máximo configurado
 * — nunca ConfigurationService/ConfigurationController. Sin ciclo:
 * ConfigurationModule nunca importa QuotesModule.
 */
@Module({
  imports: [DocumentSequencesModule, ConfigurationModule],
  controllers: [QuotesController],
  providers: [QuotesService, QuoteDocumentRenderer],
  exports: [QuotesService],
})
export class QuotesModule {}

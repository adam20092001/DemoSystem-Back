import { Module } from '@nestjs/common';
import { DocumentSequencesModule } from '../document-sequences/document-sequences.module';
import { QuoteDocumentRenderer } from './printing/quote-document.renderer';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';

/**
 * PrismaService y AuditService llegan de módulos globales (Database, Audit).
 * DocumentSequencesModule se importa aquí (encapsulado): AppModule no
 * necesita registrarlo por separado. Se exporta QuotesService para que la
 * futura Fase 6 (Ventas) pueda componerlo dentro de su propia transacción.
 */
@Module({
  imports: [DocumentSequencesModule],
  controllers: [QuotesController],
  providers: [QuotesService, QuoteDocumentRenderer],
  exports: [QuotesService],
})
export class QuotesModule {}

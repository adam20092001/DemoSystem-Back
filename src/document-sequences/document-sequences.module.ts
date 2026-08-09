import { Module } from '@nestjs/common';
import { DocumentSequenceService } from './document-sequence.service';

/**
 * PrismaService llega del módulo global Database. Se exporta
 * DocumentSequenceService para que QuotesModule (y el futuro SalesModule,
 * Fase 6) lo reutilicen dentro de su propia transacción.
 */
@Module({
  providers: [DocumentSequenceService],
  exports: [DocumentSequenceService],
})
export class DocumentSequencesModule {}

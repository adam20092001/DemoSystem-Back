import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { MAX_PURCHASE_DOCUMENT_BYTES } from './purchase-document-validator';
import {
  ImportOperationDocumentsController,
  PurchaseInvoiceAttachmentsController,
} from './purchase-invoice-attachments.controller';
import { PurchaseInvoiceAttachmentsService } from './purchase-invoice-attachments.service';
import { PURCHASE_DOCUMENT_STORAGE } from './storage/purchase-document-storage.interface';
import { LocalDiskPurchaseDocumentStorageService } from './storage/local-disk-purchase-document-storage.service';

/**
 * R5: documentos adjuntos de facturas de compra. PrismaService/AuditService
 * llegan de módulos globales. Multer en memoria: el contenido se valida
 * (firma/estructura) ANTES de escribir nada en disco; el límite de 10 MB lo
 * aplica Multer (413) y se vuelve a verificar en el validador.
 */
@Module({
  imports: [
    MulterModule.register({
      storage: memoryStorage(),
      // Multer/busboy trata el límite como EXCLUSIVO (un archivo de exactamente
      // el límite se rechaza): +1 permite exactamente 10 MB; el validador
      // vuelve a comprobar el máximo real.
      limits: { fileSize: MAX_PURCHASE_DOCUMENT_BYTES + 1, files: 1 },
    }),
  ],
  controllers: [
    PurchaseInvoiceAttachmentsController,
    ImportOperationDocumentsController,
  ],
  providers: [
    PurchaseInvoiceAttachmentsService,
    {
      provide: PURCHASE_DOCUMENT_STORAGE,
      useClass: LocalDiskPurchaseDocumentStorageService,
    },
  ],
  exports: [PurchaseInvoiceAttachmentsService],
})
export class PurchaseInvoiceAttachmentsModule {}

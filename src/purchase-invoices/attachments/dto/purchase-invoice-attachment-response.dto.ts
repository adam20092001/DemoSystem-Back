import { ApiProperty } from '@nestjs/swagger';
import { PurchaseInvoiceAttachmentStatus } from '@prisma/client';

export class SafePurchaseInvoiceAttachmentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  purchaseInvoiceId!: string;

  @ApiProperty({ description: 'Nombre original saneado (solo informativo).' })
  fileName!: string;

  @ApiProperty({
    enum: ['application/pdf', 'image/jpeg', 'image/png'],
    description: 'Tipo MIME validado contra el contenido real.',
  })
  mimeType!: string;

  @ApiProperty({ description: 'Tamaño en bytes.' })
  fileSize!: number;

  @ApiProperty({ description: 'SHA-256 hexadecimal del contenido.' })
  sha256!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  uploadedAt!: Date;

  @ApiProperty({ format: 'uuid' })
  uploadedByUserId!: string;

  @ApiProperty({ enum: PurchaseInvoiceAttachmentStatus })
  status!: PurchaseInvoiceAttachmentStatus;

  @ApiProperty({
    description: 'true solo mientras la factura está en borrador.',
  })
  canDelete!: boolean;

  @ApiProperty({ description: 'Los tres formatos admiten previsualización.' })
  previewable!: boolean;

  @ApiProperty({
    description:
      'true si es el resultado de una carga previa (misma Idempotency-Key).',
  })
  idempotentReplay!: boolean;
}

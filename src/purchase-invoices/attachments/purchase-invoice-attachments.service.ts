import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  PurchaseInvoiceAttachmentStatus,
  PurchaseInvoiceStatus,
  RoleName,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { AuditAction } from '../../audit/audit-action.enum';
import { AuditService } from '../../audit/audit.service';
import {
  BusinessConflictException,
  CodedNotFoundException,
  FieldBadRequestException,
} from '../../common/errors/error-contract';
import { PrismaService } from '../../database/prisma.service';
import { sanitizeFileName } from '../../products/utils/sanitize-file-name';
import { validatePurchaseDocument } from './purchase-document-validator';
import type { PurchaseDocumentStorage } from './storage/purchase-document-storage.interface';
import { PURCHASE_DOCUMENT_STORAGE } from './storage/purchase-document-storage.interface';
import { SafePurchaseInvoiceAttachment } from './types/safe-purchase-invoice-attachment';

/** Lectura: los mismos roles que leen la factura de compra completa (no WAREHOUSE). */
const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
  RoleName.PURCHASING,
]);
/** Carga y eliminación: los roles que crean/editan facturas de compra. */
const WRITE_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.PURCHASING,
]);

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

const ATTACHMENT_SELECT = {
  id: true,
  purchaseInvoiceId: true,
  originalFileName: true,
  mimeType: true,
  fileSize: true,
  sha256: true,
  storageKey: true,
  idempotencyKey: true,
  status: true,
  uploadedByUserId: true,
  uploadedAt: true,
} satisfies Prisma.PurchaseInvoiceAttachmentSelect;

type AttachmentRow = Prisma.PurchaseInvoiceAttachmentGetPayload<{
  select: typeof ATTACHMENT_SELECT;
}>;

export interface UploadPurchaseInvoiceAttachmentInput {
  purchaseInvoiceId: string;
  file: {
    buffer: Buffer;
    mimetype: string | undefined;
    originalname: string | undefined;
  };
  idempotencyKey?: string | null;
  actorUserId: string;
  requesterRole: RoleName;
  ipAddress?: string | null;
}

export interface RemovePurchaseInvoiceAttachmentInput {
  purchaseInvoiceId: string;
  attachmentId: string;
  actorUserId: string;
  requesterRole: RoleName;
  ipAddress?: string | null;
}

export interface PurchaseInvoiceAttachmentFile {
  stream: Readable;
  mimeType: string;
  fileSize: number;
  fileName: string;
}

function assertCanRead(role: RoleName): void {
  if (!READ_ROLES.has(role)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar documentos de facturas de compra',
    );
  }
}

function assertCanWrite(role: RoleName): void {
  if (!WRITE_ROLES.has(role)) {
    throw new ForbiddenException(
      'No tiene permisos para modificar documentos de facturas de compra',
    );
  }
}

function toSafe(
  row: AttachmentRow,
  invoiceStatus: PurchaseInvoiceStatus,
  idempotentReplay = false,
): SafePurchaseInvoiceAttachment {
  return {
    id: row.id,
    purchaseInvoiceId: row.purchaseInvoiceId,
    fileName: row.originalFileName,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    sha256: row.sha256,
    uploadedAt: row.uploadedAt,
    uploadedByUserId: row.uploadedByUserId,
    status: row.status,
    // Eliminable solo mientras la factura esté en borrador.
    canDelete:
      row.status === PurchaseInvoiceAttachmentStatus.ACTIVE &&
      invoiceStatus === PurchaseInvoiceStatus.DRAFT,
    previewable: true,
    idempotentReplay,
  };
}

/**
 * Documentos adjuntos de facturas de compra (R5). Guarda el binario en un
 * almacenamiento privado (PURCHASE_DOCUMENT_STORAGE) y solo metadatos en BD.
 * Nunca modifica la factura (estado, importes, contabilidad) ni interpreta el
 * contenido. Compensación: archivo primero, fila después; si la transacción
 * falla se retira el archivo (nunca una fila apuntando a un archivo ausente).
 */
@Injectable()
export class PurchaseInvoiceAttachmentsService {
  private readonly logger = new Logger(PurchaseInvoiceAttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @Inject(PURCHASE_DOCUMENT_STORAGE)
    private readonly storage: PurchaseDocumentStorage,
  ) {}

  // ==================================================================
  // Carga
  // ==================================================================

  async upload(
    input: UploadPurchaseInvoiceAttachmentInput,
  ): Promise<SafePurchaseInvoiceAttachment> {
    assertCanWrite(input.requesterRole);
    const idempotencyKey = this.normalizeIdempotencyKey(input.idempotencyKey);

    const validation = validatePurchaseDocument({
      buffer: input.file.buffer,
      declaredMime: input.file.mimetype,
      originalName: input.file.originalname,
    });
    if (!validation.ok) {
      throw new FieldBadRequestException({
        message: validation.rejection.message,
        code: validation.rejection.code,
        field: 'file',
        type: 'FORMAT',
      });
    }
    const sha256 = createHash('sha256').update(input.file.buffer).digest('hex');
    const fileName = sanitizeFileName(input.file.originalname);

    // Reintento idempotente: antes de escribir ningún archivo.
    if (idempotencyKey !== null) {
      const replay = await this.findIdempotent(
        input.purchaseInvoiceId,
        idempotencyKey,
        sha256,
      );
      if (replay !== null) {
        return replay;
      }
    }

    const saved = await this.storage.save({
      buffer: input.file.buffer,
      extension: validation.extension,
    });

    try {
      return await this.prisma.$transaction(async (tx) => {
        const invoiceStatus = await this.lockInvoiceShared(
          tx,
          input.purchaseInvoiceId,
        );
        if (invoiceStatus === PurchaseInvoiceStatus.CANCELLED) {
          throw new BusinessConflictException({
            message:
              'No se pueden adjuntar documentos a una factura de compra anulada',
            code: 'PURCHASE_INVOICE_CANCELLED',
          });
        }
        const created = await tx.purchaseInvoiceAttachment.create({
          data: {
            purchaseInvoiceId: input.purchaseInvoiceId,
            originalFileName: fileName,
            mimeType: validation.mime,
            fileSize: input.file.buffer.length,
            sha256,
            storageKey: saved.storageKey,
            idempotencyKey,
            uploadedByUserId: input.actorUserId,
          },
          select: ATTACHMENT_SELECT,
        });
        await this.auditService.record({
          userId: input.actorUserId,
          module: 'PURCHASE_INVOICES',
          action: AuditAction.PURCHASE_INVOICE_ATTACHMENT_UPLOADED,
          entityType: 'PurchaseInvoice',
          entityId: input.purchaseInvoiceId,
          description: 'Documento adjuntado a la factura de compra',
          metadata: {
            attachmentId: created.id,
            purchaseInvoiceId: input.purchaseInvoiceId,
            invoiceStatus,
            mimeType: created.mimeType,
            fileSize: created.fileSize,
          },
          ipAddress: input.ipAddress ?? null,
          client: tx,
        });
        return toSafe(created, invoiceStatus);
      });
    } catch (error) {
      await this.storage.delete(saved.storageKey).catch(() => {
        this.logger.error(
          'No se pudo retirar el archivo físico tras revertir la carga de un adjunto.',
        );
      });
      // Dos cargas concurrentes con la misma clave: gana una; la otra devuelve
      // el resultado de la ganadora (o 409 si el contenido difiere).
      if (
        idempotencyKey !== null &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const replay = await this.findIdempotent(
          input.purchaseInvoiceId,
          idempotencyKey,
          sha256,
        );
        if (replay !== null) {
          return replay;
        }
      }
      throw error;
    }
  }

  // ==================================================================
  // Lectura
  // ==================================================================

  async list(
    purchaseInvoiceId: string,
    requesterRole: RoleName,
  ): Promise<SafePurchaseInvoiceAttachment[]> {
    assertCanRead(requesterRole);
    const invoice = await this.prisma.purchaseInvoice.findUnique({
      where: { id: purchaseInvoiceId },
      select: { status: true },
    });
    if (invoice === null) {
      throw new NotFoundException('Factura de compra no encontrada');
    }
    const rows = await this.prisma.purchaseInvoiceAttachment.findMany({
      where: {
        purchaseInvoiceId,
        status: PurchaseInvoiceAttachmentStatus.ACTIVE,
      },
      select: ATTACHMENT_SELECT,
      orderBy: [{ uploadedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => toSafe(row, invoice.status));
  }

  /**
   * Abre el archivo para previsualizar/descargar. La autorización es previa:
   * rol de lectura + el adjunto DEBE pertenecer a la factura indicada y estar
   * ACTIVE. Un adjunto ajeno, eliminado o inexistente responde el MISMO 404
   * (conocer un id nunca basta para descargar: sin IDOR).
   */
  async openFile(
    purchaseInvoiceId: string,
    attachmentId: string,
    requesterRole: RoleName,
  ): Promise<PurchaseInvoiceAttachmentFile> {
    assertCanRead(requesterRole);
    const row = await this.prisma.purchaseInvoiceAttachment.findFirst({
      where: {
        id: attachmentId,
        purchaseInvoiceId,
        status: PurchaseInvoiceAttachmentStatus.ACTIVE,
      },
      select: ATTACHMENT_SELECT,
    });
    if (row === null) {
      throw new CodedNotFoundException(
        'Documento no encontrado',
        'ATTACHMENT_NOT_FOUND',
      );
    }
    if (!(await this.storage.exists(row.storageKey))) {
      this.logger.error(
        `Integridad: el archivo físico del adjunto ${row.id} no existe en el almacenamiento.`,
      );
      throw new CodedNotFoundException(
        'El archivo del documento no está disponible',
        'ATTACHMENT_FILE_MISSING',
      );
    }
    return {
      stream: this.storage.createReadStream(row.storageKey),
      mimeType: row.mimeType,
      fileSize: row.fileSize,
      fileName: row.originalFileName,
    };
  }

  // ==================================================================
  // Acceso desde Importaciones (mismos archivos, sin copias)
  // ==================================================================

  async listForImportOperation(
    importOperationId: string,
    requesterRole: RoleName,
  ): Promise<{
    importOperationId: string;
    purchaseInvoiceId: string | null;
    documents: SafePurchaseInvoiceAttachment[];
  }> {
    assertCanRead(requesterRole);
    const purchaseInvoiceId =
      await this.resolveOperationInvoiceId(importOperationId);
    if (purchaseInvoiceId === null) {
      return { importOperationId, purchaseInvoiceId: null, documents: [] };
    }
    return {
      importOperationId,
      purchaseInvoiceId,
      documents: await this.list(purchaseInvoiceId, requesterRole),
    };
  }

  async openFileForImportOperation(
    importOperationId: string,
    attachmentId: string,
    requesterRole: RoleName,
  ): Promise<PurchaseInvoiceAttachmentFile> {
    assertCanRead(requesterRole);
    const purchaseInvoiceId =
      await this.resolveOperationInvoiceId(importOperationId);
    if (purchaseInvoiceId === null) {
      throw new CodedNotFoundException(
        'Documento no encontrado',
        'ATTACHMENT_NOT_FOUND',
      );
    }
    return this.openFile(purchaseInvoiceId, attachmentId, requesterRole);
  }

  // ==================================================================
  // Eliminación (solo borrador)
  // ==================================================================

  async remove(input: RemovePurchaseInvoiceAttachmentInput): Promise<void> {
    assertCanWrite(input.requesterRole);

    const storageKey = await this.prisma.$transaction(async (tx) => {
      const invoiceStatus = await this.lockInvoiceShared(
        tx,
        input.purchaseInvoiceId,
      );
      if (invoiceStatus !== PurchaseInvoiceStatus.DRAFT) {
        throw new BusinessConflictException({
          message:
            'Solo se pueden eliminar documentos mientras la factura de compra esté en borrador; en una factura confirmada se conservan',
          code: 'ATTACHMENT_DELETE_NOT_ALLOWED',
        });
      }
      const rows = await tx.$queryRaw<{ id: string; storageKey: string }[]>(
        Prisma.sql`
          SELECT id, storage_key AS "storageKey"
          FROM purchase_invoice_attachments
          WHERE id = ${input.attachmentId}::uuid
            AND purchase_invoice_id = ${input.purchaseInvoiceId}::uuid
            AND status = 'ACTIVE'
          FOR UPDATE
        `,
      );
      const locked = rows[0];
      if (locked === undefined) {
        throw new CodedNotFoundException(
          'Documento no encontrado',
          'ATTACHMENT_NOT_FOUND',
        );
      }
      await tx.purchaseInvoiceAttachment.update({
        where: { id: input.attachmentId },
        data: {
          status: PurchaseInvoiceAttachmentStatus.DELETED,
          deletedAt: new Date(),
          deletedByUserId: input.actorUserId,
        },
      });
      await this.auditService.record({
        userId: input.actorUserId,
        module: 'PURCHASE_INVOICES',
        action: AuditAction.PURCHASE_INVOICE_ATTACHMENT_DELETED,
        entityType: 'PurchaseInvoice',
        entityId: input.purchaseInvoiceId,
        description: 'Documento eliminado de la factura de compra en borrador',
        metadata: {
          attachmentId: input.attachmentId,
          purchaseInvoiceId: input.purchaseInvoiceId,
        },
        ipAddress: input.ipAddress ?? null,
        client: tx,
      });
      return locked.storageKey;
    });

    // La fila ya está confirmada como DELETED: un fallo físico no revierte la
    // eliminación; solo deja un archivo huérfano inaccesible (se registra).
    try {
      await this.storage.delete(storageKey);
    } catch {
      this.logger.error(
        `No se pudo eliminar el archivo físico del adjunto ${input.attachmentId} (queda huérfano e inaccesible).`,
      );
    }
  }

  // ==================================================================
  // Helpers
  // ==================================================================

  private normalizeIdempotencyKey(
    value: string | null | undefined,
  ): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(trimmed)) {
      throw new FieldBadRequestException({
        message:
          'Idempotency-Key inválida: use 1 a 100 caracteres alfanuméricos, punto, guion, guion bajo o dos puntos',
        code: 'IDEMPOTENCY_KEY_INVALID',
        field: 'Idempotency-Key',
        type: 'FORMAT',
      });
    }
    return trimmed;
  }

  private async findIdempotent(
    purchaseInvoiceId: string,
    idempotencyKey: string,
    sha256: string,
  ): Promise<SafePurchaseInvoiceAttachment | null> {
    const existing = await this.prisma.purchaseInvoiceAttachment.findUnique({
      where: {
        purchaseInvoiceId_idempotencyKey: {
          purchaseInvoiceId,
          idempotencyKey,
        },
      },
      select: ATTACHMENT_SELECT,
    });
    if (existing === null) {
      return null;
    }
    if (
      existing.sha256 !== sha256 ||
      existing.status !== PurchaseInvoiceAttachmentStatus.ACTIVE
    ) {
      throw new BusinessConflictException({
        message:
          'La clave de idempotencia ya se usó con un contenido distinto (o con un documento eliminado)',
        code: 'IDEMPOTENCY_KEY_CONFLICT',
      });
    }
    const invoice = await this.prisma.purchaseInvoice.findUnique({
      where: { id: purchaseInvoiceId },
      select: { status: true },
    });
    return toSafe(
      existing,
      invoice?.status ?? PurchaseInvoiceStatus.DRAFT,
      true,
    );
  }

  /** FOR SHARE: serializa contra confirm()/cancel() (que toman FOR UPDATE). */
  private async lockInvoiceShared(
    tx: Prisma.TransactionClient,
    purchaseInvoiceId: string,
  ): Promise<PurchaseInvoiceStatus> {
    const rows = await tx.$queryRaw<{ status: PurchaseInvoiceStatus }[]>(
      Prisma.sql`
        SELECT status
        FROM purchase_invoices
        WHERE id = ${purchaseInvoiceId}::uuid
        FOR SHARE
      `,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('Factura de compra no encontrada');
    }
    return row.status;
  }

  private async resolveOperationInvoiceId(
    importOperationId: string,
  ): Promise<string | null> {
    const operation = await this.prisma.importOperation.findUnique({
      where: { id: importOperationId },
      select: { purchaseInvoiceId: true },
    });
    if (operation === null) {
      throw new NotFoundException('Operación de importación no encontrada');
    }
    return operation.purchaseInvoiceId;
  }
}

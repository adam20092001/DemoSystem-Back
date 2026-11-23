-- R5: documentos adjuntos de facturas de compra y recepción de mercadería desde
-- Importaciones. Migración 100% aditiva: dos tablas nuevas, dos enums nuevos y
-- una columna NULLABLE (import_receipt_links.receiving_request_id). No modifica
-- ni reescribe ninguna fila existente; no requiere backfill.

-- CreateEnum
CREATE TYPE "PurchaseInvoiceAttachmentStatus" AS ENUM ('ACTIVE', 'DELETED');

-- CreateEnum
CREATE TYPE "ImportReceivingMode" AS ENUM ('RECEIVE', 'LINK_EXISTING');

-- AlterTable
ALTER TABLE "import_receipt_links" ADD COLUMN     "receiving_request_id" UUID;

-- CreateTable
CREATE TABLE "purchase_invoice_attachments" (
    "id" UUID NOT NULL,
    "purchase_invoice_id" UUID NOT NULL,
    "original_file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "file_size" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "storage_key" VARCHAR(200) NOT NULL,
    "idempotency_key" VARCHAR(100),
    "status" "PurchaseInvoiceAttachmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "uploaded_by_user_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "deleted_by_user_id" UUID,

    CONSTRAINT "purchase_invoice_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_receiving_requests" (
    "id" UUID NOT NULL,
    "import_operation_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "mode" "ImportReceivingMode" NOT NULL,
    "completed_operation" BOOLEAN NOT NULL DEFAULT false,
    "purchase_receipt_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_receiving_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_invoice_attachments_storage_key_key" ON "purchase_invoice_attachments"("storage_key");

-- CreateIndex
CREATE INDEX "purchase_invoice_attachments_purchase_invoice_id_status_upl_idx" ON "purchase_invoice_attachments"("purchase_invoice_id", "status", "uploaded_at");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_invoice_attachments_purchase_invoice_id_idempotenc_key" ON "purchase_invoice_attachments"("purchase_invoice_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "import_receiving_requests_import_operation_id_idempotency_k_key" ON "import_receiving_requests"("import_operation_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "import_receipt_links_receiving_request_id_idx" ON "import_receipt_links"("receiving_request_id");

-- AddForeignKey
ALTER TABLE "import_receipt_links" ADD CONSTRAINT "import_receipt_links_receiving_request_id_fkey" FOREIGN KEY ("receiving_request_id") REFERENCES "import_receiving_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_attachments" ADD CONSTRAINT "purchase_invoice_attachments_purchase_invoice_id_fkey" FOREIGN KEY ("purchase_invoice_id") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_attachments" ADD CONSTRAINT "purchase_invoice_attachments_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_attachments" ADD CONSTRAINT "purchase_invoice_attachments_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_receiving_requests" ADD CONSTRAINT "import_receiving_requests_import_operation_id_fkey" FOREIGN KEY ("import_operation_id") REFERENCES "import_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_receiving_requests" ADD CONSTRAINT "import_receiving_requests_purchase_receipt_id_fkey" FOREIGN KEY ("purchase_receipt_id") REFERENCES "purchase_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_receiving_requests" ADD CONSTRAINT "import_receiving_requests_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Restricciones escritas a mano (no expresables en Prisma).
-- ---------------------------------------------------------------------------

-- Tamaño: 1 byte .. 10 MB (el límite real también se valida en la API).
ALTER TABLE "purchase_invoice_attachments"
  ADD CONSTRAINT "purchase_invoice_attachments_file_size_check"
  CHECK ("file_size" >= 1 AND "file_size" <= 10485760);

-- Solo los tipos MIME soportados (validados además por contenido en la API).
ALTER TABLE "purchase_invoice_attachments"
  ADD CONSTRAINT "purchase_invoice_attachments_mime_type_check"
  CHECK ("mime_type" IN ('application/pdf', 'image/jpeg', 'image/png'));

-- sha256 hexadecimal en minúsculas (64 caracteres).
ALTER TABLE "purchase_invoice_attachments"
  ADD CONSTRAINT "purchase_invoice_attachments_sha256_check"
  CHECK ("sha256" ~ '^[0-9a-f]{64}$');

-- Coherencia del borrado lógico: DELETED exige fecha y usuario; ACTIVE ninguno.
ALTER TABLE "purchase_invoice_attachments"
  ADD CONSTRAINT "purchase_invoice_attachments_deletion_consistency"
  CHECK (
    ("status" = 'ACTIVE' AND "deleted_at" IS NULL AND "deleted_by_user_id" IS NULL)
    OR
    ("status" = 'DELETED' AND "deleted_at" IS NOT NULL AND "deleted_by_user_id" IS NOT NULL)
  );

-- La clave de almacenamiento nunca puede contener separadores ni segmentos de
-- navegación (defensa en profundidad contra path traversal).
ALTER TABLE "purchase_invoice_attachments"
  ADD CONSTRAINT "purchase_invoice_attachments_storage_key_check"
  CHECK ("storage_key" ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$' AND "storage_key" !~ '(^|/)\.\.?(/|$)');

ALTER TABLE "import_receiving_requests"
  ADD CONSTRAINT "import_receiving_requests_request_hash_check"
  CHECK ("request_hash" ~ '^[0-9a-f]{64}$');

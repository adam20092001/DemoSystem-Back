-- Fase B1 (Importaciones): 100% aditiva. Ninguna tabla/columna existente
-- se modifica; PurchaseInvoiceLine y Product solo ganan una relación
-- inversa opcional nueva.

-- CreateEnum
CREATE TYPE "ImportOperationStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportTransportMode" AS ENUM ('SEA', 'AIR', 'LAND', 'OTHER');

-- CreateEnum
CREATE TYPE "ImportShipmentStatus" AS ENUM ('PLANNED', 'IN_TRANSIT', 'ARRIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "import_operations" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(40) NOT NULL,
    "description" VARCHAR(300),
    "origin_country" VARCHAR(2) NOT NULL,
    "destination_country" VARCHAR(2) NOT NULL,
    "status" "ImportOperationStatus" NOT NULL DEFAULT 'DRAFT',
    "external_reference" VARCHAR(100),
    "notes" VARCHAR(1000),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "completed_by_user_id" UUID,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_user_id" UUID,
    "cancellation_reason" VARCHAR(300),

    CONSTRAINT "import_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_shipments" (
    "id" UUID NOT NULL,
    "import_operation_id" UUID NOT NULL,
    "transport_mode" "ImportTransportMode" NOT NULL,
    "carrier_name" VARCHAR(150),
    "tracking_reference" VARCHAR(100),
    "bill_of_lading_number" VARCHAR(100),
    "container_reference" VARCHAR(100),
    "origin_location" VARCHAR(150),
    "destination_location" VARCHAR(150),
    "estimated_departure_date" DATE,
    "actual_departure_date" DATE,
    "estimated_arrival_date" DATE,
    "actual_arrival_date" DATE,
    "status" "ImportShipmentStatus" NOT NULL DEFAULT 'PLANNED',
    "notes" VARCHAR(1000),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_user_id" UUID,
    "cancellation_reason" VARCHAR(300),

    CONSTRAINT "import_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_shipment_lines" (
    "id" UUID NOT NULL,
    "import_shipment_id" UUID NOT NULL,
    "product_id" UUID,
    "description_snapshot" VARCHAR(300) NOT NULL,
    "planned_quantity" DECIMAL(14,3) NOT NULL,
    "unit_code" VARCHAR(15),
    "unit_name" VARCHAR(60),
    "weight_value" DECIMAL(14,3),
    "weight_unit" VARCHAR(10),
    "volume_value" DECIMAL(14,3),
    "volume_unit" VARCHAR(10),
    "purchase_invoice_line_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_shipment_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_operations_status_created_at_idx" ON "import_operations"("status", "created_at");

-- CreateIndex
CREATE INDEX "import_operations_created_at_id_idx" ON "import_operations"("created_at", "id");

-- CreateIndex
CREATE INDEX "import_shipments_import_operation_id_idx" ON "import_shipments"("import_operation_id");

-- CreateIndex
CREATE INDEX "import_shipments_status_created_at_idx" ON "import_shipments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "import_shipments_import_operation_id_bill_of_lading_number_key" ON "import_shipments"("import_operation_id", "bill_of_lading_number");

-- CreateIndex
CREATE INDEX "import_shipment_lines_import_shipment_id_idx" ON "import_shipment_lines"("import_shipment_id");

-- CreateIndex
CREATE INDEX "import_shipment_lines_product_id_idx" ON "import_shipment_lines"("product_id");

-- CreateIndex
CREATE INDEX "import_shipment_lines_purchase_invoice_line_id_idx" ON "import_shipment_lines"("purchase_invoice_line_id");

-- AddForeignKey
ALTER TABLE "import_operations" ADD CONSTRAINT "import_operations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_operations" ADD CONSTRAINT "import_operations_completed_by_user_id_fkey" FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_operations" ADD CONSTRAINT "import_operations_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipments" ADD CONSTRAINT "import_shipments_import_operation_id_fkey" FOREIGN KEY ("import_operation_id") REFERENCES "import_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipments" ADD CONSTRAINT "import_shipments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipments" ADD CONSTRAINT "import_shipments_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipment_lines" ADD CONSTRAINT "import_shipment_lines_import_shipment_id_fkey" FOREIGN KEY ("import_shipment_id") REFERENCES "import_shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipment_lines" ADD CONSTRAINT "import_shipment_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_shipment_lines" ADD CONSTRAINT "import_shipment_lines_purchase_invoice_line_id_fkey" FOREIGN KEY ("purchase_invoice_line_id") REFERENCES "purchase_invoice_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints (editado a mano, Fase B1 — el DSL de Prisma no los expresa)

-- 1. reference nunca en blanco.
ALTER TABLE "import_operations"
  ADD CONSTRAINT "import_operations_reference_not_blank"
  CHECK (BTRIM("reference") != '');

-- 2. originCountry/destinationCountry: ISO 3166-1 alpha-2, mismo criterio
--    exacto que suppliers_country_code_format.
ALTER TABLE "import_operations"
  ADD CONSTRAINT "import_operations_origin_country_format"
  CHECK ("origin_country" ~ '^[A-Z]{2}$');

ALTER TABLE "import_operations"
  ADD CONSTRAINT "import_operations_destination_country_format"
  CHECK ("destination_country" ~ '^[A-Z]{2}$');

-- 3. Consistencia de completado: COMPLETED siempre tiene ambos; cualquier
--    otro estado nunca los tiene. Cierre OPERATIVO, nunca financiero.
ALTER TABLE "import_operations"
  ADD CONSTRAINT "import_operations_completed_consistency"
  CHECK (
    ("status" = 'COMPLETED' AND "completed_at" IS NOT NULL AND "completed_by_user_id" IS NOT NULL)
    OR
    ("status" != 'COMPLETED' AND "completed_at" IS NULL AND "completed_by_user_id" IS NULL)
  );

-- 4. Consistencia de anulación: CANCELLED siempre tiene los tres; cualquier
--    otro estado nunca los tiene (mismo criterio exacto que
--    purchase_invoices_cancellation_consistency).
ALTER TABLE "import_operations"
  ADD CONSTRAINT "import_operations_cancellation_consistency"
  CHECK (
    ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancelled_by_user_id" IS NOT NULL AND "cancellation_reason" IS NOT NULL)
    OR
    ("status" != 'CANCELLED' AND "cancelled_at" IS NULL AND "cancelled_by_user_id" IS NULL AND "cancellation_reason" IS NULL)
  );

-- 5. Unicidad de reference insensible a mayúsculas/minúsculas y a espacios
--    perimetrales (mismo criterio exacto que suppliers_document_unique).
--    Sin WHERE parcial: reference nunca es nula.
CREATE UNIQUE INDEX "import_operations_reference_unique"
ON "import_operations" (UPPER(BTRIM("reference")));

-- 6. Consistencia de anulación de embarque: CANCELLED siempre tiene los
--    tres; cualquier otro estado nunca los tiene.
ALTER TABLE "import_shipments"
  ADD CONSTRAINT "import_shipments_cancellation_consistency"
  CHECK (
    ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancelled_by_user_id" IS NOT NULL AND "cancellation_reason" IS NOT NULL)
    OR
    ("status" != 'CANCELLED' AND "cancelled_at" IS NULL AND "cancelled_by_user_id" IS NULL AND "cancellation_reason" IS NULL)
  );

-- 7. cantidad planificada siempre positiva.
ALTER TABLE "import_shipment_lines"
  ADD CONSTRAINT "import_shipment_lines_planned_quantity_positive"
  CHECK ("planned_quantity" > 0);

-- 8. mediciones logísticas opcionales, nunca negativas cuando se proveen.
ALTER TABLE "import_shipment_lines"
  ADD CONSTRAINT "import_shipment_lines_weight_volume_non_negative"
  CHECK (
    ("weight_value" IS NULL OR "weight_value" >= 0)
    AND ("volume_value" IS NULL OR "volume_value" >= 0)
  );

-- 9. descriptionSnapshot nunca en blanco.
ALTER TABLE "import_shipment_lines"
  ADD CONSTRAINT "import_shipment_lines_description_not_blank"
  CHECK (BTRIM("description_snapshot") != '');

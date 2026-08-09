-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('PERSON', 'COMPANY');

-- CreateEnum
CREATE TYPE "CustomerStage" AS ENUM ('PROSPECT', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "CustomerDocumentType" AS ENUM ('DNI', 'RUC', 'CE', 'PASSPORT', 'OTHER');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "code" VARCHAR(30),
    "customer_type" "CustomerType",
    "customer_stage" "CustomerStage" NOT NULL,
    "document_type" "CustomerDocumentType",
    "document_number" VARCHAR(32),
    "name" VARCHAR(150) NOT NULL,
    "trade_name" VARCHAR(150),
    "contact_name" VARCHAR(120),
    "phone" VARCHAR(30),
    "email" VARCHAR(150),
    "address" VARCHAR(300),
    "internal_notes" VARCHAR(1000),
    "is_generic" BOOLEAN NOT NULL DEFAULT false,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_code_key" ON "customers"("code");

-- CreateIndex
CREATE INDEX "customers_created_at_id_idx" ON "customers"("created_at", "id");

-- Restricciones manuales (Fase 4, Bloque A) --------------------------------
-- El DSL de Prisma no expresa CHECK, WHERE parcial, UPPER() ni BTRIM();
-- se agregan a mano, igual que en las Fases 2 y 3.

-- 1. Un cliente normal exige type+documentType+documentNumber consistentes:
--    si se informa documentType, documentNumber es obligatorio y viceversa.
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_document_pair"
  CHECK (
    ("document_type" IS NULL AND "document_number" IS NULL)
    OR
    ("document_type" IS NOT NULL AND "document_number" IS NOT NULL)
  );

-- 2. name nunca vacío ni solo espacios.
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_name_not_blank"
  CHECK (BTRIM("name") <> '');

-- 3. Todo cliente no genérico exige customerType; el genérico no lo tiene.
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_type_generic_consistency"
  CHECK (
    ("is_generic" = false AND "customer_type" IS NOT NULL)
    OR
    ("is_generic" = true AND "customer_type" IS NULL)
  );

-- 4. El cliente genérico nunca tiene documento.
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_generic_no_document"
  CHECK (
    "is_generic" = false
    OR ("document_type" IS NULL AND "document_number" IS NULL)
  );

-- 5. El cliente genérico siempre es CUSTOMER + ACTIVE.
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_generic_stage_status"
  CHECK (
    "is_generic" = false
    OR ("customer_stage" = 'CUSTOMER' AND "status" = 'ACTIVE')
  );

-- 6. Solo el cliente genérico puede usar code = 'PUBLIC_GENERAL'; el
--    genérico siempre usa ese code exacto. Junto con UNIQUE(code), garantiza
--    como máximo una fila genérica sin un índice único parcial adicional.
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_generic_code_consistency"
  CHECK (
    ("is_generic" = true AND "code" = 'PUBLIC_GENERAL')
    OR
    ("is_generic" = false AND ("code" IS NULL OR "code" <> 'PUBLIC_GENERAL'))
  );

-- Unicidad de documento insensible a mayúsculas/minúsculas y a espacios
-- perimetrales, alineada con la normalización del servicio
-- (trim() + toUpperCase()). Parcial: solo aplica a filas con documento.
CREATE UNIQUE INDEX "customers_document_unique"
ON "customers" ("document_type", UPPER(BTRIM("document_number")))
WHERE "document_number" IS NOT NULL;

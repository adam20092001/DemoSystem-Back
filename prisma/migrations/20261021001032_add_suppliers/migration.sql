-- Fase A5.1 (maestro de proveedores). Migración 100% aditiva: ningún tipo/
-- tabla/columna existente se elimina ni se reescribe. Sin ningún vínculo a
-- Compras/Cuentas por Pagar (todavía no existen) ni a AccountingEngine/
-- AccountingSourceType (sin cambios en esta fase).

-- CreateEnum
CREATE TYPE "SupplierDocumentType" AS ENUM ('RUC', 'DNI', 'FOREIGN_TAX_ID', 'OTHER');

-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "document_type" "SupplierDocumentType" NOT NULL,
    "document_number" VARCHAR(32) NOT NULL,
    "country_code" VARCHAR(2) NOT NULL,
    "legal_name" VARCHAR(150) NOT NULL,
    "trade_name" VARCHAR(150),
    "contact_name" VARCHAR(120),
    "phone" VARCHAR(30),
    "email" VARCHAR(150),
    "address" VARCHAR(300),
    "internal_notes" VARCHAR(1000),
    "default_currency_code" VARCHAR(3),
    "status" "SupplierStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppliers_created_at_id_idx" ON "suppliers"("created_at", "id");

-- Restricciones manuales (Fase A5.1) ---------------------------------------
-- El DSL de Prisma no expresa CHECK, UPPER() ni BTRIM(); se agregan a mano,
-- mismo criterio que customers/chart_of_accounts/accounting_entries.

-- 1. legalName nunca vacío ni solo espacios.
ALTER TABLE "suppliers"
  ADD CONSTRAINT "suppliers_legal_name_not_blank"
  CHECK (BTRIM("legal_name") <> '');

-- 2. documentNumber nunca vacío ni solo espacios (a diferencia de Customer,
--    aquí document_type/document_number son NOT NULL: no existe un
--    proveedor sin documento, no hay concepto de "genérico").
ALTER TABLE "suppliers"
  ADD CONSTRAINT "suppliers_document_number_not_blank"
  CHECK (BTRIM("document_number") <> '');

-- 3. countryCode siempre 2 letras mayúsculas (ISO 3166-1 alpha-2).
ALTER TABLE "suppliers"
  ADD CONSTRAINT "suppliers_country_code_format"
  CHECK ("country_code" ~ '^[A-Z]{2}$');

-- Unicidad de documento insensible a mayúsculas/minúsculas y a espacios
-- perimetrales, alineada con la normalización del servicio (trim() +
-- toUpperCase()) — mismo criterio que customers_document_unique. Incluye
-- country_code para que un mismo literal de FOREIGN_TAX_ID en dos países
-- distintos nunca colisione entre sí. Sin WHERE parcial: document_type/
-- document_number nunca son nulos aquí.
CREATE UNIQUE INDEX "suppliers_document_unique"
ON "suppliers" ("document_type", "country_code", UPPER(BTRIM("document_number")));

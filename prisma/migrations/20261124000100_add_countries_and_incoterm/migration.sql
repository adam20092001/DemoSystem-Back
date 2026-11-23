-- R4: catálogo compartido de países + Incoterm en embarques. 100% aditiva.

-- ---------------------------------------------------------------------------
-- 1. Catálogo de países
-- ---------------------------------------------------------------------------
CREATE TABLE "countries" (
    "code" VARCHAR(2) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "pending_review" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "countries_pkey" PRIMARY KEY ("code")
);

ALTER TABLE "countries"
  ADD CONSTRAINT "countries_code_format" CHECK ("code" ~ '^[A-Z]{2}$');
ALTER TABLE "countries"
  ADD CONSTRAINT "countries_name_not_blank" CHECK (BTRIM("name") <> '');

-- Nombre único insensible a mayúsculas y espacios perimetrales (evita duplicados).
CREATE UNIQUE INDEX "countries_name_unique" ON "countries" (UPPER(BTRIM("name")));

ALTER TABLE "countries"
  ADD CONSTRAINT "countries_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Países iniciales verificados.
INSERT INTO "countries" ("code", "name", "active", "pending_review", "updated_at") VALUES
  ('CN', 'China', true, false, CURRENT_TIMESTAMP),
  ('PE', 'Perú',  true, false, CURRENT_TIMESTAMP),
  ('IN', 'India', true, false, CURRENT_TIMESTAMP);

-- Códigos históricos ya usados por proveedores o importaciones: se incorporan
-- como PENDIENTES DE REVISIÓN (nombre provisional = código; no se inventa una
-- identidad de país). Así ningún documento pierde su país al crear las FK.
INSERT INTO "countries" ("code", "name", "active", "pending_review", "updated_at")
SELECT DISTINCT used."code", used."code", true, true, CURRENT_TIMESTAMP
FROM (
  SELECT "country_code" AS "code" FROM "suppliers"
  UNION
  SELECT "origin_country" FROM "import_operations"
  UNION
  SELECT "destination_country" FROM "import_operations"
) AS used
ON CONFLICT ("code") DO NOTHING;

ALTER TABLE "suppliers"
  ADD CONSTRAINT "suppliers_country_code_fkey"
  FOREIGN KEY ("country_code") REFERENCES "countries"("code")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "import_operations"
  ADD CONSTRAINT "import_operations_origin_country_fkey"
  FOREIGN KEY ("origin_country") REFERENCES "countries"("code")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "import_operations"
  ADD CONSTRAINT "import_operations_destination_country_fkey"
  FOREIGN KEY ("destination_country") REFERENCES "countries"("code")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- 2. Incoterm en embarques (nullable; sin relleno de históricos)
-- ---------------------------------------------------------------------------
CREATE TYPE "ImportIncoterm" AS ENUM
  ('EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF');

ALTER TABLE "import_shipments"
  ADD COLUMN "incoterm" "ImportIncoterm",
  ADD COLUMN "incoterm_named_place" VARCHAR(150),
  ADD COLUMN "incoterm_version" VARCHAR(4);

-- incoterm, lugar y versión van juntos o ninguno; el lugar no puede estar en blanco.
ALTER TABLE "import_shipments"
  ADD CONSTRAINT "import_shipments_incoterm_consistency"
  CHECK (
    ("incoterm" IS NULL AND "incoterm_named_place" IS NULL AND "incoterm_version" IS NULL)
    OR
    ("incoterm" IS NOT NULL AND "incoterm_named_place" IS NOT NULL
      AND BTRIM("incoterm_named_place") <> '' AND "incoterm_version" IS NOT NULL)
  );

-- Versión admitida hoy: 2020.
ALTER TABLE "import_shipments"
  ADD CONSTRAINT "import_shipments_incoterm_version"
  CHECK ("incoterm_version" IS NULL OR "incoterm_version" = '2020');

-- FAS, FOB, CFR y CIF solo con transporte marítimo.
ALTER TABLE "import_shipments"
  ADD CONSTRAINT "import_shipments_incoterm_maritime_only"
  CHECK (
    "incoterm" IS NULL
    OR "incoterm"::text NOT IN ('FAS', 'FOB', 'CFR', 'CIF')
    OR "transport_mode"::text = 'SEA'
  );

-- R2-B1 (precios con IGV incluido — preparación de esquema únicamente) -------
--
-- Migración puramente ADITIVA: agrega `prices_include_tax` a quotes, sales y
-- electronic_documents para distinguir la semántica monetaria con la que se
-- calculó cada documento:
--   false = semántica histórica (unit_price/line_total antes de IGV; IGV
--           sumado a nivel de documento).
--   true  = precios finales con IGV incluido cuando aplica (bloques
--           posteriores de R2; ningún código escribe true todavía).
--
-- Ningún importe, estado, saldo, asiento contable, CHECK, FK ni índice
-- existente se modifica. Toda fila existente recibe false: ese ES su
-- significado real (todo documento previo a R2 se calculó con la semántica
-- histórica), así que el relleno no reinterpreta ningún documento.
--
-- Patrón (mismo criterio que el relleno de contexto fiscal de la Fase 11B,
-- 20260826190000_add_electronic_invoicing_foundation):
--   1. ADD COLUMN ... NOT NULL DEFAULT false: rellena todas las filas
--      existentes en la misma sentencia.
--   2. Verificación explícita: ninguna fila puede quedar sin valor.
--   3. DROP DEFAULT: el esquema Prisma declara las tres columnas
--      obligatorias SIN @default, para que todo escritor futuro fije la
--      semántica explícitamente (nunca "por olvido" la histórica).

-- 1. Columnas con relleno histórico.
ALTER TABLE "quotes"
  ADD COLUMN "prices_include_tax" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "sales"
  ADD COLUMN "prices_include_tax" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "electronic_documents"
  ADD COLUMN "prices_include_tax" BOOLEAN NOT NULL DEFAULT false;

-- 2. Verificación del relleno: todo documento previo debe quedar en false.
DO $$
DECLARE
  quotes_not_historical INTEGER;
  sales_not_historical INTEGER;
  documents_not_historical INTEGER;
BEGIN
  SELECT COUNT(*) INTO quotes_not_historical
    FROM "quotes" WHERE "prices_include_tax" IS DISTINCT FROM false;
  SELECT COUNT(*) INTO sales_not_historical
    FROM "sales" WHERE "prices_include_tax" IS DISTINCT FROM false;
  SELECT COUNT(*) INTO documents_not_historical
    FROM "electronic_documents" WHERE "prices_include_tax" IS DISTINCT FROM false;

  IF quotes_not_historical > 0
     OR sales_not_historical > 0
     OR documents_not_historical > 0 THEN
    RAISE EXCEPTION
      'R2-B1: relleno histórico de prices_include_tax incompleto (quotes=%, sales=%, electronic_documents=%)',
      quotes_not_historical, sales_not_historical, documents_not_historical;
  END IF;
END $$;

-- 3. Sin DEFAULT SQL: cada escritor debe fijar la semántica explícitamente.
ALTER TABLE "quotes" ALTER COLUMN "prices_include_tax" DROP DEFAULT;
ALTER TABLE "sales" ALTER COLUMN "prices_include_tax" DROP DEFAULT;
ALTER TABLE "electronic_documents" ALTER COLUMN "prices_include_tax" DROP DEFAULT;

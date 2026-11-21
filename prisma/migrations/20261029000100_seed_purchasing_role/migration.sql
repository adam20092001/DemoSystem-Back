-- R1 (rol PURCHASING) — M2 de 2. Crea la fila de "roles" para PURCHASING en
-- instalaciones YA inicializadas, para que asignar el rol funcione sin exigir
-- que alguien reejecute manualmente el seed (el seed usa upsert con
-- update: {} y nunca corrige filas existentes).
--
-- Idempotente: ON CONFLICT ("name") DO NOTHING sobre el índice único
-- roles_name_key; reaplicarla (o ejecutar luego el seed) nunca duplica ni
-- modifica la fila. No toca ningún otro rol.
--
-- "id" y "updated_at" no tienen DEFAULT en base de datos (Prisma los genera
-- en el cliente: @default(uuid()) / @updatedAt), por eso se suministran aquí:
-- gen_random_uuid() ya se usa en migraciones previas (KAN-18) y es nativa
-- desde PostgreSQL 13. La descripción debe coincidir con ROLE_DESCRIPTIONS de
-- prisma/seed.ts.

INSERT INTO "roles" ("id", "name", "description", "created_at", "updated_at")
VALUES (
    gen_random_uuid(),
    'PURCHASING',
    'Compras: proveedores y facturas de compra en borrador; consulta de recepciones y cuentas por pagar',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("name") DO NOTHING;

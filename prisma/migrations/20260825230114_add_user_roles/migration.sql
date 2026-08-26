-- KAN-18, Bloque A: soporte de múltiples roles por usuario. Un solo
-- archivo de migración, en el orden seguro exigido: (1) crear user_roles,
-- (2) copiar cada users.role_id existente a user_roles, (3) verificar la
-- copia con una aserción dentro de la propia migración (no una consulta
-- manual posterior), (4) recién entonces eliminar users.role_id y su FK/
-- índice. El rol ACTIVO de sesión (JWT) nunca se persiste: solo vive en el
-- token, validado en vivo contra user_roles en cada petición (ver
-- JwtAuthGuard) — esta migración no crea ninguna columna para eso.

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_user_id_role_id_key" ON "user_roles"("user_id", "role_id");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: copia cada asignación heredada users.role_id -> user_roles,
-- exactamente una fila por usuario existente (cada usuario legado tenía
-- exactamente un rol). gen_random_uuid() ya está disponible (pgcrypto,
-- usado por @default(uuid()) de Prisma en el resto del esquema).
INSERT INTO "user_roles" ("id", "user_id", "role_id", "created_at")
SELECT gen_random_uuid(), "id", "role_id", CURRENT_TIMESTAMP
FROM "users";

-- Aserción de integridad DENTRO de la propia migración (no una consulta
-- manual posterior entre pasos de despliegue): si algún usuario existente
-- quedara sin ninguna fila en user_roles tras el backfill, la migración
-- entera aborta (ROLLBACK automático de la transacción de migración) ANTES
-- de llegar a los DROP destructivos de más abajo. Ningún usuario puede
-- perder su rol por esta migración.
DO $$
DECLARE
  missing_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO missing_count
  FROM "users" u
  WHERE NOT EXISTS (
    SELECT 1 FROM "user_roles" ur WHERE ur."user_id" = u."id"
  );

  IF missing_count > 0 THEN
    RAISE EXCEPTION 'KAN-18 backfill de user_roles incompleto: % usuario(s) sin ninguna fila en user_roles tras la copia', missing_count;
  END IF;
END $$;

-- Solo tras la aserción anterior: eliminar la relación singular heredada.
-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_role_id_fkey";

-- DropIndex
DROP INDEX "users_role_id_idx";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "role_id";

-- R1 (rol PURCHASING) — M1 de 2. Migración 100% aditiva: solo agrega un valor
-- al enum "RoleName". Ningún tipo, tabla ni columna existente se modifica.
--
-- El valor nuevo NO se usa en este archivo: PostgreSQL no permite usar un valor
-- de enum recién agregado dentro de la misma transacción que lo agrega (mismo
-- criterio que la migración de ACCOUNTANT, Fase A4). Por eso la fila de la tabla
-- "roles" se crea en la migración siguiente (M2).

-- AlterEnum
ALTER TYPE "RoleName" ADD VALUE 'PURCHASING';

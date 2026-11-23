-- R4 (compras multimoneda): claves contables de diferencia de cambio REALIZADA.
-- Migración SEPARADA a propósito: PostgreSQL no permite USAR un valor de enum
-- recién agregado dentro de la misma transacción; esta migración solo agrega
-- los valores y ninguna migración posterior los referencia por literal.
-- Sin mapeo real: ADMIN las asigna vía PATCH /chart-of-accounts/system-keys/:systemKey.
ALTER TYPE "AccountingSystemKey" ADD VALUE 'FX_GAIN_REALIZED';
ALTER TYPE "AccountingSystemKey" ADD VALUE 'FX_LOSS_REALIZED';

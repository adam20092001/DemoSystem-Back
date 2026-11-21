# INC — Guardia débil de base de datos en las pruebas E2E

- **Estado:** abierta, preexistente (no introducida por R1), **fuera del alcance de R1**.
- **Severidad:** alta potencial (las pruebas E2E escriben y borran datos).
- **Detectada en:** revisión final previa al commit de R1 (rama `feat/r1-purchasing-role`).

## Archivos afectados

- `test/jest-e2e.setup.ts` (≈ línea 40): `process.env.DATABASE_URL?.includes('pos_db_test')`.
- `test/helpers/prisma-test-client.ts` (≈ línea 9): misma comprobación.

## Riesgo confirmado

La guardia solo busca el texto `pos_db_test` dentro de **toda** la cadena de
conexión. No valida host, puerto, usuario ni el nombre real de la base.
Evaluadas (sin conectar a ninguna base) estas URL **pasan** la guardia:

| URL | Base real a la que apunta |
|---|---|
| `postgresql://u:p@host:5432/pos_db?application_name=pos_db_test` | `pos_db` |
| `postgresql://pos_db_test:p@prod-host:5432/pos_db` | `pos_db` en otro host |
| `postgresql://u:p@host:5432/pos_db_test_prod_copy` | otra base con prefijo parecido |

Una variable `DATABASE_URL` ya presente en el entorno tiene prioridad sobre
`.env.test` (dotenv no sobrescribe), de modo que un error de configuración
puede dirigir la suite a una base distinta sin que la guardia lo note.

## Corrección necesaria (en un cambio separado)

1. Parsear la URL con `new URL()` y exigir `pathname === '/pos_db_test'`
   (nombre exacto, sin sufijos).
2. Exigir host y puerto de una lista corta permitida (`localhost`/`127.0.0.1`,
   puerto de `TEST_POSTGRES_PORT`); ampliable solo mediante una variable
   explícita y documentada.
3. Verificar la identidad real **tras conectar**: `SELECT current_database()`
   debe devolver exactamente el nombre esperado antes de ejecutar cualquier
   escritura.
4. Aplicar la misma validación en ambos archivos desde una única función
   compartida.

## Pruebas negativas necesarias

Pruebas unitarias de la función de validación que deben **rechazar**:

- `.../pos_db?application_name=pos_db_test`
- `postgresql://pos_db_test:...@otro-host/pos_db`
- `.../pos_db_test_prod_copy` y `.../pos_db_test2`
- host remoto con nombre `pos_db_test`
- URL malformada o vacía
- base real distinta a la declarada (simulada con `current_database()`)

y que **acepten** únicamente el destino esperado.

## Prohibición operativa mientras no se corrija

No ejecutar resets, `db:test:reset`, limpiezas ni suites con escrituras masivas
basándose solo en la coincidencia de texto. Antes de cualquier ejecución
destructiva, identificar el destino de forma inequívoca (host, puerto y
`SELECT current_database()`), preferiblemente en un contenedor descartable
propio. Las E2E de R1 se ejecutaron únicamente contra un contenedor descartable
verificado de esa manera.

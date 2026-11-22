# INC — Guardia débil de base de datos en las pruebas E2E

- **Estado:** mitigación **implementada en la rama `fix/e2e-database-safety-guard`,
  pendiente de revisión y de integración**. La incidencia **no se cierra** hasta
  que esa rama se revise, se integre y se verifique en el entorno real del
  equipo (ver "Verificación pendiente").
- **Severidad:** alta potencial (las pruebas E2E escriben y borran datos).
- **Origen:** preexistente (no introducida por R1). Detectada en la revisión final
  previa al commit de R1 y auditada en la Fase 1 de seguridad E2E.

## Problema original (confirmado)

La guardia era `process.env.DATABASE_URL?.includes('pos_db_test')` (duplicada en
`test/jest-e2e.setup.ts` y `test/helpers/prisma-test-client.ts`): una búsqueda de
texto sobre **toda** la cadena de conexión. Estas URL pasaban la guardia:

| URL | Base real |
|---|---|
| `postgresql://u:p@host:5432/pos_db?application_name=pos_db_test` | `pos_db` |
| `postgresql://pos_db_test:p@prod-host:5432/pos_db` | `pos_db` en otro host |
| `postgresql://u:p@host:5432/pos_db_test_prod_copy` | otra base de nombre parecido |

Además: una `DATABASE_URL` ya definida en el shell prevalecía sobre `.env.test`
(dotenv no sobrescribe); `prisma:test:deploy` y `prisma:test:seed` pasaban por
`scripts/run-with-env.js`, que no validaba nada; y `db:test:reset` borraba el
volumen **antes** de saber a qué destino apuntarían el deploy y el seed.

## Remediación implementada

Módulo compartido `scripts/lib/test-db-guard.js` (CommonJS, con declaraciones en
`test-db-guard.d.ts`), usado por:

| Camino | Mecanismo |
|---|---|
| `npm run test:e2e` | `test/jest-e2e.global-setup.ts` (política + identidad real, una vez, antes de cargar suites; un fallo aborta toda la corrida) + `test/jest-e2e.setup.ts` y helpers (política síncrona + huella del proceso) |
| `prisma:test:deploy` / `prisma:test:seed` | `scripts/run-with-test-db.js` (valida antes de lanzar Prisma y construye el entorno del hijo explícitamente) |
| `db:test:reset` | `scripts/test-db-preflight.js` (solo lectura) **antes** de `db:test:down:clean`; deploy y seed protegidos |
| Bases descartables | `E2E_DISPOSABLE_TARGET` + `E2E_DISPOSABLE_TOKEN` solo en `.env.test.local`; `npm run db:test:mark-disposable` |

Política (detalle en el README; las bases descartables también exigen host
local y nunca el puerto 5432): `new URL()`, protocolo PostgreSQL, host local,
puerto `TEST_POSTGRES_PORT`, base exacta `pos_db_test`, usuario TEST, lista
blanca de parámetros, nombres reservados, `NODE_ENV` ≠ production; identidad con
`current_database()`/usuario de sesión; marcador (`COMMENT ON DATABASE`, hash
del token + identificador de clúster cuando `pg_control_system()` es legible)
para descartables; archivos autoritativos (conflicto con el shell = error).

### Hallazgos durante la implementación

- `ts-jest` consume sin avisos el módulo CommonJS con su `.d.ts`; no fue
  necesario tocar `tsconfig` ni la configuración de transformación.
- `globalSetup` aborta la ejecución antes de cargar cualquier suite y sus
  variables llegan a las suites (también con varios workers: la huella se acepta
  si su PID es el del proceso o el de su padre).
- `pg_control_system()` fue accesible también para un rol **sin** privilegios de
  superusuario en PostgreSQL 16 (imagen `postgres:16-alpine`); el marcador queda
  atado al clúster. Si en otro servidor no fuera legible, el marcador se crea sin
  identificador de clúster y se informa.
- Prisma carga el `.env` de **desarrollo** en `process.env` al construir un
  `PrismaClient`. Eso contaminaba el entorno (y el del proceso hijo) con valores
  de `pos_db`. El ejecutor de la guardia restaura `process.env` tras usar el
  cliente y el wrapper toma una copia del entorno antes de cualquier cliente.
  Test de integración dedicado.
- `docker-compose.yml` solo lee el `.env` raíz o el shell, no `.env.test`: un
  `TEST_POSTGRES_PORT` únicamente en `.env.test` desalinea la URL y el contenedor.
  El preflight de `db:test:reset` compara el puerto publicado efectivo.

### Cobertura de pruebas

- `npm run test:scripts` (node:test, sin base de datos): matriz de la guardia,
  wrapper, preflight y las pruebas existentes de limpieza Docker.
- `npm run test:scripts:integration` (Docker; contenedores propios, puertos
  aleatorios, `tmpfs`, sin volúmenes; elimina solo lo que creó tras verificar su
  etiqueta por ID): destino canónico, no autorizado, conexión no disponible,
  marcador ausente/incorrecto/de otro clúster/con datos, migración y seed solo
  tras el preflight, rol sin superusuario, `DATABASE_URL` heredada.

### Remediación de la revisión final (M1 y M2)

- **M1 — bases descartables solo locales.** `E2E_DISPOSABLE_TARGET` aceptaba
  cualquier host (`resolvePolicy`). Ahora el host, normalizado con `new URL()`
  y comparado de forma exacta, debe ser `localhost`, `127.0.0.1` o `::1`; LAN,
  dominios, IP públicas y alias arbitrarios se rechazan, y el puerto 5432 se
  rechaza siempre. Se mantienen el piso de nombre `pos_db_test_<sufijo>`, el
  destino único exacto, el token y el marcador. Pruebas negativas en
  `scripts/lib/test-db-guard.test.js`.
- **M2 — demonio Docker local.** El preflight de `db:test:reset` rechaza
  (`DOCKER_NOT_LOCAL`), antes de cualquier otra consulta de Docker, un
  `DOCKER_HOST` definido, un `DOCKER_CONTEXT` contradictorio y cualquier
  contexto cuyo endpoint real (`docker context inspect`) no sea un pipe
  `npipe:////./pipe/*` o un socket `unix:///*` locales; también respuestas
  ausentes, inválidas o con más de una entrada. Pruebas con Docker simulado en
  `scripts/test-db-preflight.test.js`. `db-test-clean-volume.js` no se modificó.
- **Límite residual de M2:** los pasos de `db:test:reset` son procesos
  separados; el entorno es el mismo, pero el contexto activo vive en la
  configuración de Docker y un `docker context use` entre el preflight y la
  limpieza no se detecta (la limpieza no repite esta comprobación).

## Suites E2E que fallan en `main` (registrar como incidencia independiente)

Cuatro suites (`accounting-periods`, `electronic-invoicing`, `configuration`,
`users-admin-concurrency`; 5 pruebas de 1784) fallaron al ejecutar las 53 suites
sobre una base descartable nueva. Se reprodujeron en aislamiento y en un
worktree de `main` con la guardia antigua. **No se corrigieron aquí.**
Limitaciones de la evidencia: (a) no se compararon los fallos por nombre (la
rama dio 5 fallos y `main` 6 sobre las mismas 38 pruebas, lo que sugiere
inestabilidad en las pruebas de concurrencia); (b) una sola corrida por lado,
sin repeticiones; (c) ambas sobre bases recién creadas: algunos fallos (cuenta
`BANK` sin mapeo, bloqueo de moneda A0.2) pueden depender del estado y del
orden y no está demostrado que ocurran en el `pos_db_test` habitual del equipo.
Se consideran preexistentes en esta máquina con base nueva, no atribuibles a
esta rama. Siguiente paso sugerido: 3 corridas por lado con nombres capturados
y una base con el mismo estado que la del equipo.

## Límites y riesgos residuales (no resueltos por esta corrección)

- Comandos manuales: `npx prisma migrate reset`, `psql`, `docker compose down -v`,
  `docker volume rm`.
- `current_database()` y el marcador **no autentican** al servidor; un túnel o
  servidor equivocado con una base homónima solo se mitiga con credenciales
  distintas por entorno y roles sin acceso a producción.
- Ventana corta entre la verificación y la conexión propia de la CLI de Prisma; no
  hay reverificación periódica durante una corrida larga de Jest.
- El preflight y `db-test-clean-volume.js` resuelven el recurso Docker por
  separado (el segundo se conserva sin cambios, con su verificación cruzada).

### Riesgos de los scripts de desarrollo (registrados aparte, sin modificar)

Estos scripts **no** fueron cambiados y quedan fuera de esta guardia; deberían
tratarse en una incidencia propia:

- `prisma:deploy`, `prisma:migrate` (`migrate dev` puede proponer un reset),
  `db:seed` y `db:seed:demo` usan `.env` (base `pos_db`) sin ninguna validación
  de destino; `db:seed:demo` solo rechaza `NODE_ENV=production`.
- `npm run db:down` detiene todo el stack (incluida `pos_db`).
- Una `DATABASE_URL` exportada en el shell los redirige sin aviso (precedencia de
  dotenv).

## Verificación pendiente para cerrar la incidencia

1. Revisión y aprobación de la rama; integración a `main`.
2. Confirmar en el equipo real que `.env.test` y `docker-compose.yml` están
   alineados (el preflight lo exige) y que `npm run db:test:reset` funciona de
   extremo a extremo **en una máquina donde se acepte tocar `pos_db_test`** (no se
   ejecutó durante esta implementación).
3. Verificar que `pos_db` y `pos_db_test` existentes no cambiaron (ver README).
4. Decidir si se abre la incidencia de scripts de desarrollo.

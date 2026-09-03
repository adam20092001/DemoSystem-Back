# DemoSystem — Backend

Backend (y **solo** backend) de un sistema web interno de **Punto de Venta y
Gestión Comercial**. NestJS + TypeScript + PostgreSQL + Prisma. Expone una
API REST documentada con Swagger; no contiene ningún frontend.

El contexto de trabajo y las reglas de negocio del proyecto están en
[CLAUDE.md](CLAUDE.md).

## Qué incluye este MVP

Autenticación multi-rol (JWT en cookie HttpOnly) · Usuarios y roles ·
Catálogo (categorías, unidades, productos) · Inventario (movimientos y
saldo) · Clientes (incluye "Público general") · Cotizaciones · Ventas / POS ·
Pagos (métodos de pago administrables por ADMIN) y cuentas por cobrar ·
Contabilidad básica · Reportes y dashboard · Configuración y correlativos ·
Auditoría · **Facturación electrónica (demostración)**.

> ⚠️ **Facturación electrónica = demostración, no SUNAT real.** El único
> proveedor implementado es `MockElectronicInvoicingProvider`
> (`ELECTRONIC_INVOICING_PROVIDER=mock`). Un documento en estado `ACCEPTED`
> significa que el proveedor simulado lo aceptó — **no tiene validez fiscal
> ante SUNAT**. No hay PSE real, XML/UBL, CDR, firma digital, certificado,
> QR, notas de crédito/débito ni conciliación con un proveedor externo. Ver
> la sección [Límites de la facturación electrónica](#límites-de-la-facturación-electrónica).

## Requisitos

- Node.js 20 o superior (este repositorio se desarrolla con Node 24; no hay
  un límite superior conocido, pero no se ha probado con versiones más
  antiguas que 20).
- Docker Desktop (Windows/macOS) o Docker Engine + Docker Compose (Linux).
- Git.

No hay archivo `.nvmrc` ni campo `engines` en `package.json`: lo anterior es
una recomendación, no una validación automática.

## Puesta en marcha (quick start)

```bash
# 1. Clonar e instalar dependencias
git clone <url-del-repositorio>
cd DemoSystem-Back
npm install
```

Crear el archivo de entorno local:

```bash
# bash / Git Bash / macOS / Linux
cp .env.example .env
```

```powershell
# PowerShell
Copy-Item .env.example .env
```

Editar `.env` y completar, como mínimo: `POSTGRES_PASSWORD`, `JWT_SECRET`
(≥32 caracteres — ver el comentario del propio archivo para generarlo) e
`INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD`.
Ver [Variables de entorno requeridas](#variables-de-entorno-requeridas).

```bash
# 2. Levantar PostgreSQL (contenedor pos_db)
npm run db:up

# 3. Generar Prisma Client
npm run prisma:generate

# 4. Aplicar el historial de migraciones (NO usar "migrate dev" aquí:
#    "deploy" aplica migraciones ya existentes sin generar una nueva)
npm run prisma:deploy

# 5. Sembrar datos de infraestructura (roles, admin inicial, catálogo base,
#    "Público general", secuencias, plan de cuentas, configuración)
npm run db:seed

# 6. Levantar el servidor en modo desarrollo
npm run start:dev
```

La API queda disponible en `http://localhost:3000/api/v1` (o el `PORT` que
hayas configurado). El health check (`GET /api/v1/health`) responde `200`
cuando PostgreSQL está disponible y `503` si no.

## Swagger

Si `SWAGGER_ENABLED=true` (valor por defecto), la documentación interactiva
queda disponible en:

```
http://localhost:<PORT>/api/docs
```

Swagger es la referencia para el cuerpo exacto de cada request — este README
no repite cada DTO. La autenticación es por **cookie HttpOnly**: tras un
login exitoso vía `POST /api/v1/auth/login`, el navegador/cliente HTTP
adjunta la cookie automáticamente en las siguientes peticiones (Swagger UI
respeta esta cookie igual que cualquier otro cliente).

## Variables de entorno requeridas

Todas se validan al arrancar (`src/config/env.validation.ts`); la aplicación
**no inicia** si alguna falta o es inválida. Ver
[.env.example](.env.example) para la lista completa y comentada. Las más
relevantes para arrancar por primera vez:

| Variable | Uso |
|---|---|
| `DATABASE_URL` | Cadena de conexión PostgreSQL; debe coincidir con los `POSTGRES_*` de Docker Compose. |
| `POSTGRES_PASSWORD` | Obligatoria para levantar el contenedor `pos_db` (sin valor por defecto). |
| `JWT_SECRET` | Mínimo 32 caracteres. No usar el valor de ejemplo del archivo. |
| `CORS_ORIGIN` | Orígenes permitidos (uno o varios separados por coma). |
| `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` | Solo las consume `prisma/seed.ts` (no NestJS en tiempo de ejecución). Crean el usuario ADMIN inicial. La contraseña debe cumplir la política vigente (mínimo 12 caracteres, al menos una letra y un número). |

`AUTH_COOKIE_SAMESITE=none` exige `NODE_ENV=production` (el navegador
descarta `SameSite=None` sin `Secure=true`, que solo se activa en
producción) — la aplicación falla al arrancar si se combinan mal, en vez de
emitir cookies que el navegador descartaría en silencio.

## Usuario administrador inicial

`npm run db:seed` crea el usuario ADMIN definido por `INITIAL_ADMIN_*` con
`mustChangePassword=true`: el primer login exige cambiar la contraseña antes
de continuar (`POST /api/v1/auth/change-password`). Reejecutar el seed
**nunca** resetea su contraseña ni pisa ediciones administrativas
posteriores — el seed es idempotente por diseño.

## Datos de demostración opcionales

`npm run db:seed` **nunca** crea datos ficticios (productos, clientes de
prueba, ventas, etc.): es un seed de infraestructura, seguro para cualquier
entorno. Para tener algo que mostrar de inmediato existe un seed **separado
y explícitamente opcional**:

```bash
# 1. Definir una contraseña para el usuario de demostración en .env
#    (debe cumplir la misma política de contraseñas que cualquier usuario)
echo DEMO_USER_PASSWORD=TuClaveDeDemo1234 >> .env

# 2. Ejecutarlo
npm run db:seed:demo
```

Qué crea (idempotente: reejecutarlo no duplica nada, no resetea la
contraseña del usuario demo, no revierte el stock ya registrado):

- **Un usuario multi-rol**: `demo@demosystem.local` con los 4 roles
  (`ADMIN`, `SELLER`, `WAREHOUSE`, `MANAGEMENT`) asignados — suficiente para
  demostrar el cambio de rol activo (KAN-18) sin crear cuentas separadas.
  Nace con `mustChangePassword=true`, igual que cualquier usuario nuevo.
- **7 productos** de catálogo (`DEMO-SKU-001`…`DEMO-SKU-007`, prefijo
  reconocible), usando las categorías/unidades ya sembradas por
  `npm run db:seed`. Uno de ellos es un **SERVICE** (no descuenta stock),
  para poder mostrar esa invariante en vivo.
- **2 clientes** no genéricos: una **COMPANY** con RUC sintético de 11
  dígitos (`DEMO-CUST-COMPANY`, usable en el flujo de FACTURA) y una
  **PERSON** con DNI sintético de 8 dígitos (`DEMO-CUST-PERSON`).
- **Stock inicial** para los productos inventariables, registrado con el
  mismo motor transaccional que usa la API en producción
  (`StockMovementEngine`) — nunca escribiendo el saldo a mano.

Qué **no** crea, nunca: `Quote`, `Sale`, `Payment`, `AccountingEntry` ni
`ElectronicDocument`. Esos registros tienen efectos de negocio (correlativos,
inventario, pagos, contabilidad, ciclo fiscal) que solo la API real debe
producir — se generan en vivo siguiendo el flujo de la siguiente sección.
Tampoco toca `DocumentSequence`/`FiscalSeries` (nunca retrocede un
correlativo) ni sobrescribe `CompanySettings` (la identidad de la empresa se
configura explícitamente, ver el paso D del flujo de abajo).

**El script se niega a ejecutarse si `NODE_ENV=production`**, sin ninguna
bandera para forzarlo. Nunca lo ejecutes contra una base con datos reales.

## Flujo de demostración recomendado

Usa rutas y comportamiento reales; el cuerpo exacto de cada request está en
Swagger.

1. **Login** como el usuario demo (`POST /api/v1/auth/login` con
   `demo@demosystem.local` y `DEMO_USER_PASSWORD`).
2. **Cambiar la contraseña temporal** (`POST /api/v1/auth/change-password`) —
   obligatorio antes de poder usar el resto de la API.
3. **Rol activo → ADMIN** (`POST /api/v1/auth/switch-role`, si el rol activo
   tras el login no es ya `ADMIN`).
4. **Configurar la empresa** con una identidad sintética
   (`PATCH /api/v1/configuration`, solo ADMIN): `businessName`, un `taxId`
   sintético (11 dígitos) y `address`. Este paso es manual a propósito — el
   seed nunca sobrescribe `CompanySettings` por si ya configuraste una
   identidad real.
5. **Explorar el catálogo/clientes/stock sembrados**
   (`GET /api/v1/products`, `GET /api/v1/customers`,
   `GET /api/v1/inventory/products/:productId/stock`).
6. **Crear una cotización** (`POST /api/v1/quotes`) usando el cliente
   `DEMO-CUST-COMPANY` y algunos de los productos sembrados.
7. **Convertir la cotización en venta**
   (`POST /api/v1/sales/from-quote/:quoteId`) — la cotización nunca
   descuenta stock; la venta confirmada sí.
8. **Registrar un pago** (`POST /api/v1/sales/:saleId/payments`).
9. **Revisar contabilidad y cuentas por cobrar**
   (`GET /api/v1/accounting/entries`, `GET /api/v1/accounts-receivable`) —
   los asientos se generan automáticamente al confirmar la venta/pago.
10. **Revisar dashboard y reportes**
    (`GET /api/v1/dashboard`, `GET /api/v1/reports/...`).
11. **Emitir FACTURA** sobre esa venta
    (`POST /api/v1/sales/:saleId/electronic-documents` con
    `documentType: "FACTURA"`, `series: "F001"` — la serie sembrada por
    `npm run db:seed`). Requiere un cliente identificado con RUC: por eso el
    paso 6 usa `DEMO-CUST-COMPANY`, no "Público general".
12. **Abrir la representación imprimible**
    (`GET /api/v1/electronic-documents/:id/print`) — incluye el aviso
    obligatorio de que es una simulación (MOCK/DEMO), nunca un comprobante
    fiscal real.
13. Opcionalmente, **cambiar el rol activo a SELLER, WAREHOUSE o MANAGEMENT**
    (mismo usuario, mismo `POST /api/v1/auth/switch-role`) para comprobar en
    vivo las diferencias de autorización — por ejemplo, `WAREHOUSE` no puede
    ver reportes/dashboard, y solo `ADMIN` puede reintentar un documento
    fiscal fallido.

### Escenario BOLETA (opcional, breve)

Una venta con "Público general" pagada al contado, con total en soles menor
o igual a S/700, puede emitir **BOLETA** (`documentType: "BOLETA"`,
`series: "B001"`) sin requerir un cliente identificado. Por encima de ese
umbral, BOLETA exige un cliente con documento igual que FACTURA. (Regla
completa en `CLAUDE.md` y en el código de
`src/electronic-invoicing/electronic-documents.service.ts`; no se repite
aquí en detalle.)

## Límites de la facturación electrónica

- Proveedor actual: **`mock`** (`ELECTRONIC_INVOICING_PROVIDER=mock`),
  determinístico y siempre `ACCEPTED` salvo que el propio test/demo fuerce
  un fallo simulado.
- **No incluido**: integración real con SUNAT o un PSE, generación de
  XML/UBL, CDR, firma digital, certificado, código QR, notas de
  crédito/débito, ni conciliación con un proveedor externo.
- Un documento `ACCEPTED` por el proveedor MOCK **no tiene validez fiscal**.
  La representación imprimible lo indica explícitamente.

## Métodos de pago

Los métodos de pago son **dinámicos y administrables por ADMIN**, no un enum
fijo del backend:

- El frontend debe obtener la lista de métodos seleccionables mediante
  `GET /api/v1/payment-methods` — solo los métodos con `active: true` deben
  ofrecerse para un cobro nuevo (un método inactivo existe únicamente por
  historial y el backend rechaza usarlo en un pago nuevo).
- ADMIN administra el catálogo completo con
  `POST /api/v1/payment-methods` (crear) y
  `PATCH /api/v1/payment-methods/:id` (renombrar, activar/desactivar, cambiar
  `requiresReference`/`affectsCashDrawer`/`accountingDestination`/`sortOrder`).
  El `code` es inmutable una vez creado.
- Las requests de pago (`POST /api/v1/sales/:saleId/payments`, o el pago
  inicial embebido en `POST /api/v1/sales` /
  `POST /api/v1/sales/from-quote/:quoteId`) siguen enviando `method` como
  texto — ahora el *código* de un método dinámico (p. ej. `"CASH"`), nunca un
  `id`. La respuesta de un pago incluye `method` (código) y `methodName`
  (nombre visible), ambos **snapshots** del método en el instante del cobro:
  si ADMIN renombra o desactiva el método después, los pagos ya registrados
  no cambian.
- Baseline sembrado (`npm run db:seed`): **activos** `CASH`, `CARD`,
  `TRANSFER`, `YAPE`, `PLIN`; **inactivos** (históricos, preservados solo
  para no perder trazabilidad) `BANK_TRANSFER`, `BANK_DEPOSIT`,
  `DIGITAL_WALLET`, `OTHER`.
- Si un método exige referencia (`requiresReference`) es configuración por
  método, no una regla fija por código — el backend la valida al momento del
  cobro contra la configuración vigente de ese método.

## Base de datos

```bash
npm run db:up      # Levanta PostgreSQL de desarrollo (pos_db)
npm run db:down    # Detiene todo (pos_db y pos_db_test)
npm run db:logs    # Logs en vivo de pos_db
npm run db:seed        # Seed de infraestructura (seguro en cualquier entorno)
npm run db:seed:demo   # Seed OPCIONAL de demostración (nunca en producción)
```

### Base de datos de pruebas (pos_db_test)

Completamente independiente de `pos_db`: contenedor, puerto (`5433` por
defecto), credenciales y volumen propios — nunca comparte datos con
desarrollo.

```bash
npm run db:test:up          # Levanta pos_db_test
npm run db:test:down        # Detiene pos_db_test (conserva sus datos)
npm run db:test:down:clean  # Elimina contenedor + volumen de pos_db_test
npm run db:test:reset       # down:clean + up + migrate deploy + seed, listo para probar
```

`db:test:reset` (y `prisma:test:deploy`/`prisma:test:seed` por separado) necesitan
el archivo `.env.test` ya creado (copia `.env.test.example`) — no solo
`test:e2e`. Sin él, fallan con un error claro en vez de tocar otra base.

> ⚠️ **`db:test:down:clean` y `db:test:reset` son destructivos ÚNICAMENTE
> para `pos_db_test`.** Resuelven el volumen a borrar por las etiquetas que
> el propio Docker Compose le asigna (nunca por un nombre de volumen escrito
> a mano), y verifican esa identidad antes de borrar nada — pero solo tocan
> el stack de pruebas. **No existe un `db:reset` para `pos_db`**: este
> repositorio no ofrece (ni se recomienda inventar aquí) un procedimiento
> automático para borrar la base de desarrollo. Si necesitas reiniciar
> `pos_db` desde cero, hazlo manualmente y con el mismo cuidado que
> aplicarías a cualquier base con datos que te importan.

## Pruebas

```bash
npm run lint:check   # ESLint de solo lectura — nunca modifica archivos
npm run lint         # ESLint con --fix — SÍ modifica archivos
npm test             # Pruebas unitarias (Jest, src/**/*.spec.ts)
npm run test:e2e     # Pruebas end-to-end (requieren pos_db_test levantada)
npm run test:cov     # Cobertura de pruebas unitarias
```

`npm run test:e2e` necesita `pos_db_test` arriba (`npm run db:test:up`) y un
archivo `.env.test` (copia `.env.test.example`, ver los comentarios de ese
archivo). Las suites e2e validan en su propio arranque que `DATABASE_URL`
apunte a `pos_db_test` — si no es así, fallan explícitamente en vez de
arriesgar otra base.

## Arquitectura (resumen)

Monolito modular en NestJS: un solo despliegue, un módulo por dominio bajo
`src/` (`auth`, `users`, `categories`, `units`, `products`, `inventory`,
`customers`, `quotes`, `sales`, `payments`, `payment-methods`, `accounting`,
`reports`, `configuration`, `audit`, `electronic-invoicing`, más soporte
interno como `document-sequences`). Cada módulo separa controller (HTTP/roles/Swagger),
service (reglas de negocio y transacciones) y DTOs (validación de entrada);
Prisma solo se usa desde la capa de servicios, nunca desde los controllers.

Invariantes transaccionales relevantes: los correlativos
(`DocumentSequence`/`FiscalSeries`) y los movimientos de stock se generan
dentro de `prisma.$transaction`, con bloqueo a nivel de fila donde hace
falta evitar condiciones de carrera; una venta confirmada descuenta stock,
una cotización nunca lo hace; los pagos no pueden superar el saldo
pendiente; los asientos contables deben cuadrar (debe = haber) o la
transacción se revierte. El detalle completo de estas reglas vive en
[CLAUDE.md](CLAUDE.md) §6, no se repite aquí.

La facturación electrónica usa una abstracción de proveedor
(`ElectronicInvoicingProvider`) con una única implementación hoy
(`MockElectronicInvoicingProvider`) — añadir un proveedor real en el futuro
no debería requerir cambiar el resto del dominio.

Para el detalle de reglas de negocio, convenciones de código y alcance
explícitamente fuera del MVP, ver [CLAUDE.md](CLAUDE.md). Para el contrato
exacto de cada endpoint, ver Swagger (`/api/docs`).

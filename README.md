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
Pagos directos (métodos de pago administrables por ADMIN, sin sesión de
caja) y cuentas por cobrar · Contabilidad básica · Reportes y dashboard ·
Configuración y correlativos · Auditoría · **Facturación electrónica
(demostración)**.

El antiguo módulo de **Caja / arqueo** fue retirado por decisión del cliente:
ya no hay apertura, cierre ni arqueo, y los cobros se registran directamente.
Ver [Caja retirada](#caja-retirada).

Requerimientos post-MVP ya integrados: **pagos iniciales múltiples** al
confirmar una venta (R1), **precios de catálogo con IGV incluido** (R2) y
**lookup de usuarios** para los filtros de vendedor/cobrador (R3). Ver
[Pagos iniciales](#pagos-iniciales-al-confirmar-una-venta),
[Precios con IGV incluido](#precios-con-igv-incluido) y
[Filtros de vendedor y cobrador](#filtros-de-vendedor-y-cobrador).

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
   `DEMO-CUST-COMPANY` y algunos de los productos sembrados. Los precios del
   catálogo son finales (IGV incluido): el detalle devuelve `total`,
   `taxableBase`, `taxAmount` y `customerDiscountAmount` ya calculados.
7. **Convertir la cotización en venta**
   (`POST /api/v1/sales/from-quote/:quoteId`) — la cotización nunca
   descuenta stock; la venta confirmada sí. Opcionalmente con un pago inicial
   (`payment`) o varios (`payments[]`). Alternativamente, **venta directa**
   con `POST /api/v1/sales`. No hace falta abrir ninguna caja.
8. **Registrar un pago directo** sobre el saldo pendiente
   (`POST /api/v1/sales/:saleId/payments`), con cualquier método activo
   (incluido `CASH`).
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

## SIRE DEMO (demostración; sin SUNAT)

Módulo de **demostración** que simula el flujo del SIRE (RVIE: registro de ventas e ingresos; RCE: registro de
compras): previsualiza los documentos del periodo, permite cargar una "propuesta" y la concilia contra los datos
del sistema. **No se comunica con SUNAT**, no genera tickets, constancias ni códigos CAR, y los comprobantes
electrónicos MOCK no tienen validez fiscal. Contratos REST para el frontend: [docs/sire-demo-api.md](docs/sire-demo-api.md).

**Variables** (todas `false` por defecto; solo aceptan `true`/`false`; ver `.env.example`):

| Variable | Efecto |
|---|---|
| `SIRE_DEMO_ENABLED` | Interruptor maestro. En `false` el módulo no existe: sus rutas responden 404 y no aparecen en Swagger. |
| `SIRE_DEMO_FIXTURES_ENABLED` | Habilita el origen `DEMO_FIXTURES` (datos sintéticos versionados). Sin `SIRE_DEMO_ENABLED=true` el arranque falla. |
| `SIRE_DEMO_ALLOW_IN_PRODUCTION` | Con `NODE_ENV=production`, `SIRE_DEMO_ENABLED=true` exige esta autorización explícita; sin ella el arranque falla. |

**Orígenes** (nunca se mezclan): `POS` (solo lectura de `ElectronicDocument` ACCEPTED para RVIE y de
`PurchaseInvoice` CONFIRMED para RCE) y `DEMO_FIXTURES` (conjunto versionado `demo-fixtures-v1`, sin acceso a la
base de datos; la propuesta guarda su versión y nunca se sustituye por otra).

**Rutas** (`/api/v1/sire-demo`, 8): `context`, `registers/:register/documents`, `registers/:register/sample-file`,
`POST proposals`, `GET proposals`, `POST proposals/:id/discard`, `GET proposals/:id/reconciliation`,
`GET proposals/:id/reconciliation/export.xlsx`. ADMIN y ACCOUNTANT leen y escriben; MANAGEMENT solo lee;
SELLER y WAREHOUSE no tienen acceso.

**Cómo ejecutar la demostración** (sin tocar datos comerciales):

1. En `.env`: `SIRE_DEMO_ENABLED=true` y `SIRE_DEMO_FIXTURES_ENABLED=true`; reiniciar el backend.
2. Descargar el archivo de ejemplo: `GET /api/v1/sire-demo/registers/rvie/sample-file?source=DEMO_FIXTURES&period=202601`.
3. Cargarlo: `POST /api/v1/sire-demo/proposals` (multipart: `file`, `source=DEMO_FIXTURES`, `register=RVIE`, `period=202601`).
4. Conciliar: `GET /api/v1/sire-demo/proposals/:id/reconciliation` y, si se desea, `.../export.xlsx`.
   Los fixtures incluyen las 8 clasificaciones (coincidentes, faltantes, diferencias de monto/contraparte/fecha,
   duplicado e insuficiencia de datos). Igual para `rce`.

**Formato DEMO_V1** (propio de esta demostración; **no** es un layout oficial de SUNAT): `.txt` UTF-8 delimitado por
`|`, máximo 2 MB y 5000 filas. Primera línea `#DEMO_V1|SOURCE=<POS|DEMO_FIXTURES>|REGISTER=<RVIE|RCE>|PERIOD=<YYYYMM>`
(más `|FIXTURE=<versión>` con DEMO_FIXTURES); segunda línea `#COLUMNS|docTypeCode|series|number|issueDate|cpDocTypeCode|cpDocNumber|cpName|currency|taxableBase|igv|total`;
luego una fila de 11 campos por documento (`01|F001|00000012|05/01/2026|6|99999000001|NOMBRE|PEN|847.46|152.54|1000.00`):
fecha `DD/MM/YYYY`, importes con punto y hasta 2 decimales, moneda `PEN`. Se rechaza el archivo completo si una fila es inválida.

**Limitaciones frente al SIRE oficial**: sin integración con SUNAT (ni PSE, XML/UBL, CDR, firma, QR); sin notas de
crédito/débito; sin multimoneda (solo se suma PEN); los códigos de comprobante (`01`, `03`) e identidad (RUC→6, DNI→1,
CE→4, PASSPORT→7) y la regla del periodo (RVIE: fecha de emisión en America/Lima; RCE: fecha contable) son
**provisionales**; no valida ningún layout ni propuesta oficial.

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

## Pagos iniciales al confirmar una venta

`POST /api/v1/sales` y `POST /api/v1/sales/from-quote/:quoteId` aceptan,
de forma opcional y **excluyente**:

- `payment`: un único pago inicial (`method`, `amount`, `reference`
  opcional), o
- `payments`: un lote de **1 a 10** pagos iniciales (se admiten métodos
  repetidos).

Enviar ambos responde `400`. El lote se registra en la **misma transacción**
que confirma la venta y en el orden recibido: si cualquier pago falla (método
inactivo, referencia faltante, etc.), no se confirma nada. La suma de los
pagos no puede superar el total (`409`); una venta a "Público general" o a un
cliente bloqueado exige que la suma salde el total. Los pagos se registran
directamente, sin caja. Un pago parcial deja saldo pendiente sujeto a las
reglas de crédito vigentes, y el saldo se cobra después con
`POST /api/v1/sales/:saleId/payments`.

## Precios con IGV incluido

- El `salePrice` de cada producto es el **precio final al cliente**: incluye
  el IGV cuando `taxEnabled=true` en la configuración. El backend nunca suma
  IGV encima del precio de catálogo.
- Ejemplo con IGV 18 %: precio `118.00` → `total` 118.00, `taxableBase`
  100.00, `taxAmount` 18.00.
- El `discountAmount` que se **envía** al crear o editar una cotización o
  venta es el descuento **al cliente** sobre el precio final. El
  `discountAmount` que se **devuelve/persiste** en documentos nuevos es ese
  descuento sin IGV; el descuento que vio el cliente se expone en
  `customerDiscountAmount`.
- Los detalles de cotización, venta y comprobante incluyen los campos
  aditivos `pricesIncludeTax`, `itemsTotal`, `customerDiscountAmount` y
  `taxableBase` (los listados no cambian de forma).
- **Documentos históricos** (`pricesIncludeTax=false`, anteriores a la
  migración `20261012020000_add_prices_include_tax_snapshot`) conservan su
  semántica original: líneas antes de impuesto e IGV sumado al final. Sus
  montos nunca se reescriben; una cotización histórica solo admite cambios no
  comerciales (vigencia, notas) — cambiar ítems o descuento responde `409`.
  Convertir una cotización en venta conserva sus montos y su
  `pricesIncludeTax` originales.
- Reporte `GET /api/v1/reports/sales-by-product`: `totalSold` es el importe
  de línea al cliente **antes** del descuento de documento; para ventas
  históricas con IGV se deriva con la tasa congelada de cada venta, nunca con
  la configuración vigente.

## Filtros de vendedor y cobrador

`GET /api/v1/users/lookup` (rol activo `ADMIN`, `SELLER` o `MANAGEMENT`)
devuelve la identidad mínima de **todos** los usuarios (`id`, `username`,
`firstName`, `lastName`, `status`, incluidos inactivos/bloqueados), sin
paginación ni datos sensibles. Sirve para alimentar los filtros que el
backend ya aplica:

- `sellerId` en `GET /api/v1/sales`, `GET /api/v1/quotes`,
  `GET /api/v1/accounts-receivable` y en los reportes `sales-by-seller` y
  `quotes-by-status`.
- `createdByUserId` (cobrador) en `GET /api/v1/payments` y en el reporte
  `payments-by-method`.

## Caja retirada

Por decisión del cliente, el módulo operativo de **Caja / arqueo** fue
eliminado:

- No existe apertura, cierre, arqueo ni aprobación/rechazo de descuadres.
  Los 7 endpoints `/api/v1/cash-sessions/*` ya no están registrados (responden
  `404`) y no aparecen en Swagger.
- Los cobros se registran **directamente**: pago único o lote de pagos al
  confirmar una venta, y pagos posteriores con
  `POST /api/v1/sales/:saleId/payments`. La ausencia de caja nunca produce un
  error.
- Siguen vigentes todas las demás reglas de cobro: método dinámico activo,
  `requiresReference` por método, prohibición de sobrepago, atomicidad de los
  pagos iniciales, asientos ORIGINAL/REVERSAL según `accountingDestination`
  (CASH → Caja contable, BANK → Bancos) y auditoría del usuario que cobra.
- `CASH` (efectivo) sigue existiendo como **método de pago**; lo retirado es
  la sesión de caja, no el efectivo.
- `affectsCashDrawer` se conserva en los métodos de pago y como snapshot de
  cada `Payment` por compatibilidad; ya no controla ninguna caja.
- **Historial conservado**: las tablas `cash_sessions` y
  `cash_session_payment_method_summaries`, sus restricciones y la columna
  `Payment.cashSessionId` siguen en el esquema (sin migración nueva; siguen
  siendo 15). Los pagos antiguos conservan su vínculo y siguen siendo
  legibles y anulables; los pagos nuevos quedan con `cashSessionId` nulo.

### Nota de integración para el frontend (Angular)

- Retirar la pantalla y el menú de Caja.
- Retirar todas las llamadas a `/api/v1/cash-sessions/*` (ahora responden
  `404`).
- Retirar las validaciones locales `hasOpenSession()` y permitir registrar
  pagos sin abrir caja.
- Los contratos de venta y pago (`POST /api/v1/sales`,
  `POST /api/v1/sales/from-quote/:quoteId`,
  `POST /api/v1/sales/:saleId/payments`) mantienen sus solicitudes y
  respuestas; solo desaparecen los errores `409` relacionados con caja.
- Quedan además **otros cambios de frontend pendientes**, entre ellos mostrar
  los precios finales con IGV incluido (ver
  [Precios con IGV incluido](#precios-con-igv-incluido)).

### Decisiones del cliente pendientes (no implementadas)

- El vendedor solo puede ver sus ventas; el administrador ve todas.
- El vendedor no puede cobrar ni marcar como entregadas ventas ajenas. Hoy
  todavía puede cobrarlas: es comportamiento heredado, no una regla aprobada.
- Crédito opcional.
- Referencias de pago no obligatorias.
- Descuentos por producto, y descuentos en soles o en porcentaje.
- Cambios solicitados en inventario, contabilidad e importaciones.

## Base de datos

```bash
npm run db:up      # Levanta PostgreSQL de desarrollo (pos_db)
npm run db:down    # Detiene todo (pos_db y pos_db_test)
npm run db:logs    # Logs en vivo de pos_db
npm run db:seed        # Seed de infraestructura (seguro en cualquier entorno)
npm run db:seed:demo   # Seed OPCIONAL de demostración (nunca en producción)
```

El historial tiene **15 migraciones**; la última,
`20261012020000_add_prices_include_tax_snapshot` (R2), agrega
`prices_include_tax` a `quotes`, `sales` y `electronic_documents` (filas
existentes en `false`, sin DEFAULT final). La versión actual de la
aplicación **requiere** esa migración: en una base existente, aplicarla con
`npm run prisma:deploy` (tras un backup) antes de arrancar. Para verificar el
estado sin modificar nada: `npx prisma migrate status`.

### Corrección del orden de migraciones (P3018, A6.1)

Reconstruir la base desde cero fallaba con `P3018`: la migración de Inventory
Valuation (A6.1) creaba una clave foránea hacia `purchase_receipt_lines`, tabla
que crea la migración de Purchase Receipts (A5.2b), que por su nombre se
ordenaba **después**. Nunca falló en bases incrementales porque se aplicaron en
el orden de desarrollo.

| | Nombre |
|---|---|
| Anterior | `20261022000000_add_inventory_valuation` |
| Nuevo | `20261023120000_add_inventory_valuation` |

El contenido de `migration.sql` es idéntico (solo cambia el nombre de la
carpeta). Las **instalaciones nuevas** usan directamente el historial corregido
(`npm run prisma:deploy` desde cero) y no requieren ningún paso adicional.

**Bases existentes** (las que ya aplicaron A6.1 con el nombre anterior): antes
de ejecutar cualquier migración con el historial nuevo hay que reconciliar el
nombre registrado en `_prisma_migrations`. Si se ejecuta `migrate deploy` antes,
Prisma ve la migración con el nombre nuevo como pendiente, intenta recrear
objetos que ya existen, falla con `P3018` y deja una fila fallida que bloquea
despliegues posteriores. Renombrar una migración ya aplicada **no es una
operación documentada oficialmente por Prisma**, por lo que se hace con un
procedimiento controlado, nunca con `migrate resolve` (no renombra):

1. Congelar despliegues y `migrate deploy`/`migrate dev` contra esa base.
2. Respaldar la base (`pg_dump`) y la tabla `_prisma_migrations`.
3. Verificar que la fila anterior existe, está terminada (`finished_at` no nulo,
   `rolled_back_at` nulo) y que su checksum coincide con el SHA-256 de
   `migration.sql` (con CRLF o con LF; Prisma acepta ambas variantes).
4. En una transacción, cambiar `migration_name` del nombre anterior al nuevo
   con esa misma condición y **confirmar solo si afecta exactamente 1 fila**.
5. Comprobar `npx prisma migrate status` ("up to date") y que
   `migrate deploy` aplica 0 migraciones.

Reversión: la operación inversa con la misma guarda, o restaurar el respaldo.
Reconciliación y reversión ya se verificaron en copias aisladas; esa
verificación **no** se ha ejecutado sobre `pos_db` ni `pos_db_test`.
Coordinar el merge y la reconciliación en una misma ventana controlada, sin
`migrate deploy` intermedio. Una base que aún no aplicó A6.1 no necesita nada.

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

Limitaciones conocidas: la suite e2e pasa en ejecuciones consecutivas sin
reset, pero varias suites dejan residuos en `products` y `audit_logs`, y el
cliente genérico sembrado no se conserva al terminar (cada suite lo recrea);
el aislamiento global entre suites no está completamente resuelto. Hay 11
errores preexistentes en `tsc --noEmit` (no afectan `build` ni las pruebas) y
el repositorio no tiene CI configurado en GitHub.

## Arquitectura (resumen)

Monolito modular en NestJS: un solo despliegue, un módulo por dominio bajo
`src/` (`auth`, `users`, `categories`, `units`, `products`, `inventory`,
`customers`, `quotes`, `sales`, `payments`, `payment-methods`,
`accounting`, `reports`, `configuration`, `audit`, `electronic-invoicing`, más
soporte interno como `document-sequences`). Cada módulo separa controller (HTTP/roles/Swagger),
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

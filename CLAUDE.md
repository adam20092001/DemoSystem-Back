# CLAUDE.md

Contexto permanente para Claude Code en este repositorio.
Leer este archivo completo antes de proponer o escribir código.

---

## 1. Qué es este repositorio

Backend (y **solo** backend) de un sistema web interno de **Punto de Venta y Gestión Comercial**.

- No contiene frontend. No generar componentes de UI aquí.
- Expone una **API REST** consumida por un cliente web separado.
- La fuente funcional de verdad es el documento maestro (ver sección 10).

---

## 2. Stack obligatorio

| Área | Tecnología |
|---|---|
| Framework | NestJS |
| Lenguaje | TypeScript |
| Base de datos | PostgreSQL |
| ORM | Prisma |
| API | REST |
| Documentación API | Swagger / OpenAPI |
| Autenticación | JWT en **cookie HttpOnly** |
| Contenedores | Docker + Docker Compose |
| Pruebas | Jest |

No introducir tecnologías fuera de esta lista sin autorización explícita
(nada de GraphQL, Redis, colas, ORMs alternativos, gateways, etc.).

---

## 3. Arquitectura

- **Monolito modular**: un solo despliegue, módulos NestJS bien delimitados.
- **Clean Architecture ligera**: separación clara entre capa HTTP, capa de negocio y acceso a datos.
- **Sin microservicios.**
- **Sin sobreingeniería**: no abstraer lo que aún no tiene un segundo caso de uso real.

Estructura esperada por módulo:

```
src/
  modules/
    <module>/
      <module>.module.ts
      <module>.controller.ts       # HTTP: rutas, guards, Swagger
      <module>.service.ts          # reglas de negocio, transacciones
      dto/                         # DTOs de entrada/salida + class-validator
      entities/                    # tipos de dominio / mapeos
  common/                          # guards, decorators, filters, interceptors, pipes
  database/                        # PrismaService y módulo
  config/                          # configuración y validación de variables de entorno
```

Reglas de capas:

- El **controller** no contiene lógica de negocio: valida, autoriza y delega.
- El **service** concentra reglas, invariantes y transacciones.
- **Prisma solo se usa desde la capa de servicios/repositorios**, nunca desde controllers.
- Toda entrada se valida con DTOs (`class-validator` + `ValidationPipe` global con `whitelist`).

---

## 4. Módulos del MVP

1. **Autenticación** — login, logout, refresh, sesión por cookie HttpOnly.
2. **Usuarios y roles** — alta, edición, activación/desactivación, asignación de rol.
3. **Dashboard** — métricas agregadas de ventas, cobranzas y stock.
4. **Categorías** — clasificación de productos.
5. **Unidades** — unidades de medida.
6. **Productos** — bienes inventariables y servicios no inventariables.
7. **Inventario** — movimientos de stock (entradas, salidas, ajustes) y saldo actual.
8. **Clientes** — incluye el cliente especial **Público general**.
9. **Cotizaciones** — propuestas comerciales, sin efecto sobre stock. Desde R2 se calculan con precios finales (IGV incluido); ver §6 "Precios e IGV".
10. **Ventas / POS** — registro y confirmación de ventas. Desde R1, la confirmación (directa o desde cotización) admite un pago inicial único (`payment`) o un lote de 1 a 10 pagos iniciales (`payments[]`), excluyentes entre sí y registrados en la misma transacción que la venta.
11. **Pagos** — cobros aplicados a ventas, control de saldo pendiente. El método de pago (`method`) es un código dinámico administrado por ADMIN (`PaymentMethodsModule`, `GET/POST/PATCH /api/v1/payment-methods`), no un enum fijo: cada `Payment` resuelve y snapshotea el método (código, nombre, si afecta caja) en el instante del cobro, así que un método renombrado o desactivado después nunca altera pagos ya registrados. Baseline inicial: `CASH`/`CARD`/`TRANSFER`/`YAPE`/`PLIN` activos; `BANK_TRANSFER`/`BANK_DEPOSIT`/`DIGITAL_WALLET`/`OTHER` inactivos (preservados solo por historial). Solo un método `active` puede usarse en un cobro nuevo; `requiresReference` también es configuración por método, no una regla fija por código.
12. **Contabilidad básica** — asientos derivados de ventas, pagos y anulaciones.
13. **Reportes** — ventas, cobranzas, inventario, cuentas por cobrar.
14. **Configuración y correlativos** — parámetros del sistema y series de documentos.
15. **Auditoría** — registro de acciones críticas.
16. **Facturación electrónica (demostración)** — emisión de FACTURA/BOLETA sobre ventas confirmadas mediante una abstracción de proveedor (`ElectronicInvoicingProvider`), con `MockElectronicInvoicingProvider` como única implementación existente. Un documento `ACCEPTED` por el proveedor MOCK no tiene validez fiscal ante SUNAT (ver §7). Series fiscales (`FiscalSeries`) separadas de los correlativos comerciales (`DocumentSequence`).
17. **Caja / arqueo de caja — RETIRADO** (decisión del cliente, rama `feat/remove-cash-sessions`). El módulo operativo `CashSessionsModule` y sus 7 endpoints (`/api/v1/cash-sessions/*`) ya no existen: no hay apertura, cierre, arqueo ni aprobación/rechazo de descuadres. Los cobros se registran directamente (ver §6 "Cobros"). Se conservan en el esquema, solo por historial, las tablas `cash_sessions` y `cash_session_payment_method_summaries`, el enum `CashSessionStatus`, la columna nullable `Payment.cashSessionId` (vínculos antiguos intactos) y las acciones de auditoría `CASH_SESSION_*`.

---

## 5. Roles

- `ADMIN` — acceso total, configuración y usuarios.
- `SELLER` — cotizaciones, ventas, pagos, clientes.
- `WAREHOUSE` — productos, categorías, unidades, inventario.
- `MANAGEMENT` — dashboard y reportes (lectura y análisis).

La autorización se resuelve **siempre en el backend** mediante guards y decoradores de rol.
El frontend puede ocultar opciones, pero eso **no** cuenta como control de acceso.

---

## 6. Reglas críticas de negocio

Estas reglas son invariantes del sistema. Cualquier implementación que las contradiga es incorrecta.

**Stock e inventario**
- La **cotización no descuenta stock**.
- La **venta confirmada sí descuenta stock**.
- **No se permite stock negativo**: si no hay stock suficiente, la operación falla.
- El stock **solo cambia mediante movimientos de inventario**; nunca por escritura directa del saldo.
- Los **servicios no inventariables no descuentan stock**.

**Ventas, clientes y pagos**
- Una **venta con deuda no puede usar al cliente Público general** (ese cliente solo admite ventas pagadas al contado).
- Un **pago no puede superar el saldo pendiente** de la venta.
- Las **ventas confirmadas no se editan**: se **anulan**.
- Los **pagos no se editan**: se **anulan con motivo** obligatorio.
- La **anulación de una venta debe revertir stock y contabilidad**.
- **Pagos iniciales (R1)**: `payment` y `payments[]` son excluyentes (enviar ambos → 400); `payments[]` admite de 1 a 10 elementos (`MAX_INITIAL_PAYMENTS`), con métodos repetidos. Todo el lote pasa por `PaymentEngine` en la misma transacción que confirma la venta y en el orden recibido: si un pago falla, no se confirma nada. La suma no puede superar el total (409); Público general o cliente bloqueado exigen que la suma salde el total.

**Precios e IGV (R2)**
- El `salePrice` del catálogo es el **precio final al cliente** (IGV incluido cuando el IGV está activo). Nunca se suma IGV encima.
- Cada `Quote`, `Sale` y `ElectronicDocument` guarda `pricesIncludeTax` (snapshot, sin `@default`): `true` en documentos nuevos; `false` en todo documento previo a R2 (semántica histórica: líneas antes de impuesto, IGV sumado a nivel de documento).
- Cálculo con precios finales (`calculateTaxInclusiveTotals`, `Prisma.Decimal`, HALF_UP a 2 decimales): `total = Σ lineTotal − descuento al cliente`; `taxableBase = ROUND(total / (1 + tasa/100), 2)`; `taxAmount = total − taxableBase` (residual); `discountAmount` persistido = descuento al cliente sin IGV. Las CHECK de base de datos no cambian.
- El descuento enviado al crear/editar es el **descuento al cliente** sobre el precio final; sus límites (≤ total de ítems y ≤ `maxDiscountPercent`) se evalúan sobre ese importe.
- **Documentos históricos**: sus montos nunca se reescriben ni se reinterpretan. Una cotización histórica solo admite ediciones no comerciales (vigencia, notas); cambiar ítems o descuento responde 409. La conversión de cotización a venta copia `pricesIncludeTax` y los montos tal cual.
- Los detalles de cotización, venta y comprobante exponen campos aditivos derivados: `pricesIncludeTax`, `itemsTotal`, `customerDiscountAmount` y `taxableBase`.

**Documentos y datos**
- Los **correlativos se generan en el backend, dentro de una transacción** (nunca en el cliente, nunca fuera de transacción).
- Se guardan **snapshots del producto** (código, nombre, precio, unidad, impuestos) en cotizaciones y ventas: los cambios posteriores del catálogo no alteran documentos emitidos.
- **No se eliminan físicamente** registros con historial; se desactivan o anulan (borrado lógico).

**Cobros (sin Caja)**
- Un **`Payment` se registra directamente, sin sesión de caja**: no existe apertura, cierre ni arqueo, y la ausencia de caja nunca produce 409. No se crean sesiones automáticas ni ficticias.
- `PaymentEngine.register()` sigue siendo el único escritor de `Payment`: resuelve el método dinámico en la misma transacción (inexistente → 404, inactivo → 409), aplica `requiresReference` del método, snapshotea código/nombre/`affectsCashDrawer` y postea el asiento ORIGINAL según `accountingDestination` (CASH/BANK). La anulación postea el REVERSAL.
- El sobrepago sigue bloqueado bajo `Sale FOR UPDATE`; los pagos iniciales de R1 siguen siendo atómicos con la venta.
- `createdByUserId` y la auditoría `PAYMENT_REGISTERED` identifican al usuario autenticado que cobra (puede diferir del `sellerId` de la venta).
- Los pagos nuevos quedan con `cashSessionId = NULL`; los pagos históricos conservan su vínculo y siguen siendo legibles y anulables. Las cajas históricas no se recalculan ni modifican.
- `affectsCashDrawer` se conserva por compatibilidad como atributo del método y snapshot histórico; ya no controla ninguna caja.

**Transversales**
- Los **roles y permisos se validan desde el backend**.
- Las **operaciones críticas usan transacciones** (`prisma.$transaction`): venta, anulación, pago, correlativo, movimiento de inventario, asiento contable.
- Las **acciones críticas generan auditoría** (quién, qué, cuándo, sobre qué entidad).
- Los **asientos contables deben cuadrar**: total debe = total haber; si no cuadra, la transacción se revierte.

---

## 7. Fuera del alcance del MVP

No implementar, ni preparar abstracciones anticipadas para:

- Alquileres
- Facturación electrónica SUNAT **real** (PSE, XML/UBL, CDR, firma digital, certificado, QR, notas de crédito/débito, conciliación con proveedor externo). La demostración con proveedor MOCK sí existe (ver §4, módulo 16) y no debe confundirse con esto.
- Compras y proveedores completos
- Kardex valorizado
- Multi-almacén
- Multi-moneda
- CRM avanzado
- Ecommerce
- Aplicación móvil
- Integraciones externas

Si una tarea parece requerir algo de esta lista, **detenerse y consultar** antes de implementar.

---

## 8. Convenciones

**Idioma**
- Código, tablas, campos, variables, DTOs y endpoints: **en inglés**.
- Documentación funcional, comentarios de negocio y mensajes al usuario: **en español**.

**Nomenclatura**
- Tablas/modelos Prisma: `PascalCase` singular (`Product`, `SaleItem`).
- Columnas y campos: `camelCase` en Prisma; mapear a `snake_case` en BD si se define así en el schema (mantener el criterio elegido de forma uniforme).
- Endpoints REST: sustantivos en plural en inglés (`/products`, `/sales/:id/payments`).
- Enums en `UPPER_SNAKE_CASE` (`ADMIN`, `SALE_CONFIRMED`).

**TypeScript**
- **No usar `any`** salvo justificación escrita en comentario.
- Tipar explícitamente los retornos públicos de servicios y controllers.
- Respetar ESLint y Prettier del repositorio (`npm run lint`, `npm run format`).

**Seguridad y configuración**
- **No almacenar secretos en Git.**
- Toda configuración mediante **variables de entorno**, validadas al arrancar.
- Mantener **`.env.example`** actualizado; **`.env` nunca se sube** (debe estar en `.gitignore`).
- JWT en cookie **HttpOnly**, `secure` en producción, `sameSite` adecuado; no exponer el token al JavaScript del cliente.
- Contraseñas con hash (bcrypt/argon2). Nunca en texto plano, nunca en logs.

**Base de datos**
- Todo cambio de esquema pasa por **migraciones Prisma** (`prisma migrate dev` / `deploy`).
- No editar la base de datos a mano ni usar `db push` en flujos con datos reales.

**API**
- **Swagger siempre actualizado**: decorar controllers y DTOs (`@ApiTags`, `@ApiOperation`, `@ApiResponse`, `@ApiProperty`).
- Respuestas de error consistentes vía filtro de excepciones global.

**Pruebas**
- Jest. **Cada regla crítica de la sección 6 debe tener prueba** (unitaria o e2e).
- Priorizar: stock negativo, cotización sin descuento de stock, pago mayor al saldo, Público general con deuda, reversión por anulación, unicidad de correlativos, cuadre de asientos.

---

## 9. Flujo de trabajo con Claude Code

1. **Antes de implementar un módulo, presentar un plan y esperar aprobación.**
   El plan debe incluir: modelos Prisma, endpoints, DTOs, reglas aplicadas, transacciones y pruebas previstas.
2. **No hacer commits ni push sin autorización explícita.**
3. No modificar archivos fuera del alcance solicitado.
4. Ante ambigüedad funcional, consultar el documento maestro; si persiste la duda, preguntar antes de asumir.
5. Cambios acotados y revisables; evitar refactors masivos no solicitados.

---

## 10. Fuente funcional

Documento maestro del proyecto:

```
docs/Documento_Maestro_POS_Gestion_Comercial_MVP.docx
```

> Es la referencia funcional oficial; ante conflicto entre este CLAUDE.md y el documento,
> prevalece el documento maestro y debe actualizarse este archivo.

---

## 11. Estado actual del repositorio

Los 16 módulos base de la sección 4 están implementados, incluida la
autenticación multi-rol (KAN-18: un usuario puede tener varios roles
asignados; la sesión elige uno activo) y la facturación electrónica de
demostración (Fase 11, proveedor MOCK). Prisma, Swagger, Docker Compose,
`.env.example` y el esquema completo existen y están en uso. El módulo 17
(Caja) fue una incorporación post-MVP posterior, hoy retirada funcionalmente
(detalle más abajo).

El repositorio está en **Fase 12 (estabilización de demo)**: auditoría de
todo lo anterior, mejoras de tooling de bajo riesgo (`lint:check`, reset
seguro de la base de pruebas) y datos/documentación de demostración
opcionales — sin nuevas reglas de negocio ni módulos nuevos. Ver
[README.md](README.md) para la puesta en marcha y el flujo de demostración
recomendado.

Sobre esa base estabilizada, el Ticket C post-MVP (rama `feat/payment-methods`)
convirtió el método de pago de un enum fijo a administración dinámica por
ADMIN (`PaymentMethodsModule` + `PaymentEngine`, ver §4 punto 11): migración
EXPAND, API de administración y migración CONTRACT que retira el enum y la
columna antiguos. Los 9 métodos baseline y el comportamiento de cobro/anulación
existente se preservan sin cambios funcionales para el resto del dominio.

El Ticket B post-MVP (rama `feat/cash-sessions`, 4 bloques + estabilización)
agregó el módulo de caja (`CashSessionsModule`, ver §4 punto 17): persistencia
(migración `20260903225735_add_cash_sessions`, aditiva, `Payment.cashSessionId`
nullable), apertura/lectura, el flujo completo de cierre/descuadre/aprobación/
rechazo, y finalmente la integración obligatoria con `PaymentEngine.register()`
(todo `Payment` nuevo exige la caja `OPEN` del cobrador; se vincula
automáticamente). Máquina de 3 estados exacta: `OPEN` → `CLOSED` (sin
descuadre) o `OPEN` → `PENDING_APPROVAL` → `CLOSED`/`OPEN` (aprobación/rechazo
de un descuadre) — nunca `REJECTED`/`CANCELLED`/`APPROVED` como estado, ni
reapertura desde `CLOSED`. **Este módulo fue retirado después** (ver
"Eliminación de Caja" más abajo); el párrafo se mantiene solo para explicar el
origen de las tablas históricas.

Requerimientos post-MVP integrados en `main` después de Caja:

- **R3** (PR #19) — `GET /api/v1/users/lookup` (roles activos `ADMIN`,
  `SELLER`, `MANAGEMENT`): identidad mínima (`id`, `username`, `firstName`,
  `lastName`, `status`) de todos los usuarios, incluidos inactivos/bloqueados,
  sin paginación y sin email/roles, para alimentar los filtros backend ya
  existentes de vendedor (`sellerId` en ventas, cotizaciones, cuentas por
  cobrar y reportes) y de cobrador (`createdByUserId` en pagos y en el reporte
  de pagos por método).
- **R1** (PR #20) — pagos iniciales múltiples (`payments[]`) al confirmar una
  venta directa o desde cotización; ver §4 punto 10 y §6.
- **R2** (PR #21) — precios de catálogo con IGV incluido, snapshot
  `pricesIncludeTax`, impresos y reporte de ventas por producto
  (`totalSold` = importe de línea al cliente antes del descuento de documento,
  con la tasa congelada de cada venta histórica); ver §6 "Precios e IGV".
  Migración `20261012020000_add_prices_include_tax_snapshot` (aditiva; filas
  históricas en `false`, sin DEFAULT final). La aplicación actual **requiere**
  esta migración aplicada antes de arrancar.

**Eliminación de Caja** (rama `feat/remove-cash-sessions`, bloques C1–C4, por
decisión del cliente):

- C1: `PaymentEngine` ya no exige, bloquea ni vincula una `CashSession`;
  `PaymentsModule` ya no importa `CashSessionsModule`.
- C2: retirado `src/cash-sessions/` completo (controller con sus 7 endpoints,
  servicio, lector, calculadora, DTOs y specs) y su registro en `AppModule`.
- C3: pruebas E2E adaptadas (cobro directo, concurrencia, compatibilidad
  histórica, rutas retiradas → 404); suites de Caja eliminadas.
- C4: documentación y Swagger.
- Sin cambios de esquema ni migración nueva: las tablas, FK, CHECK, índices y
  el enum de Caja se conservan solo por historial.
- R1 (pagos múltiples), R2 (IGV incluido) y R3 (lookup y filtros) no cambian.

**Decisiones del cliente pendientes (NO implementadas):** vendedor solo ve
sus ventas; vendedor no puede cobrar ni marcar entregadas ventas ajenas;
administrador ve todas las ventas; crédito opcional; referencias de pago no
obligatorias; descuentos por producto; descuentos en soles o porcentaje;
cambios de inventario, contabilidad e importaciones. Hoy un vendedor todavía
puede cobrar ventas ajenas: la prueba E2E que lo ejercita describe
comportamiento heredado, no una regla aprobada.

**Riesgos técnicos conocidos:** varias suites E2E dejan residuos en
`products` y `audit_logs`, y el cliente genérico del seed de pruebas no se
conserva al terminar (la suite pasa igualmente dos veces seguidas, pero el
aislamiento global no está completamente resuelto); 11 errores preexistentes
en `tsc --noEmit`; el frontend todavía depende de Caja; no hay CI en GitHub.

Migraciones totales: **15**.

---

## 12. Comandos

```bash
npm run start:dev     # desarrollo con watch
npm run build         # compilar
npm run start:prod    # ejecutar build
npm run lint          # ESLint con --fix (modifica archivos)
npm run lint:check    # ESLint de solo lectura (Fase 12B)
npm run format        # Prettier
npm test              # pruebas unitarias
npm run test:cov      # cobertura
npm run test:e2e      # pruebas e2e
```

Prisma:

```bash
npx prisma migrate dev --name <nombre>   # nueva migración (desarrollo)
npm run prisma:deploy                    # aplicar migraciones existentes
npm run prisma:generate
npm run prisma:studio
npm run db:seed                          # seed de infraestructura
npm run db:seed:demo                     # seed OPCIONAL de demostración (nunca en producción)
```

Base de datos de pruebas (`pos_db_test`, Fase 12B):

```bash
npm run db:test:up
npm run db:test:down:clean   # elimina contenedor + volumen de pos_db_test (solo pruebas)
npm run db:test:reset        # down:clean + up + migrate deploy + seed
```

Ver [README.md](README.md) para la puesta en marcha completa y el detalle de
cada variable de entorno.

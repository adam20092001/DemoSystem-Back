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
3. **Dashboard** — métricas agregadas de ventas, cobranzas y stock. Las secciones comerciales (sales/collections/quotes/receivables) están restringidas por propiedad del vendedor desde P6-E2 (ver §6 "Propiedad y autorización por vendedor" y §11).
4. **Categorías** — clasificación de productos.
5. **Unidades** — unidades de medida.
6. **Productos** — bienes inventariables y servicios no inventariables.
7. **Inventario** — movimientos de stock (entradas, salidas, ajustes) y saldo actual. Cada producto inventariable tiene su propio umbral configurable (`stockMinimum`, por defecto 3 unidades en productos nuevos desde NR-04); `GET /inventory/low-stock` expone los productos en o por debajo de su umbral con una clasificación derivada `stockStatus` (`NORMAL`/`LOW_STOCK`/`OUT_OF_STOCK`, nunca persistida). No genera correos ni notificaciones automáticas, ni bloquea ninguna venta.
8. **Clientes** — incluye el cliente especial **Público general**.
9. **Cotizaciones** — propuestas comerciales, sin efecto sobre stock. Desde R2 se calculan con precios finales (IGV incluido); ver §6 "Precios e IGV".
10. **Ventas / POS** — registro y confirmación de ventas. Desde R1, la confirmación (directa o desde cotización) admite un pago inicial único (`payment`) o un lote de 1 a 10 pagos iniciales (`payments[]`), excluyentes entre sí y registrados en la misma transacción que la venta.
11. **Pagos** — cobros aplicados a ventas, control de saldo pendiente. El método de pago (`method`) es un código dinámico administrado por ADMIN (`PaymentMethodsModule`, `GET/POST/PATCH /api/v1/payment-methods`), no un enum fijo: cada `Payment` resuelve y snapshotea el método (código, nombre, si afecta caja) en el instante del cobro, así que un método renombrado o desactivado después nunca altera pagos ya registrados. Baseline inicial: `CASH`/`CARD`/`TRANSFER`/`YAPE`/`PLIN` activos; `BANK_TRANSFER`/`BANK_DEPOSIT`/`DIGITAL_WALLET`/`OTHER` inactivos (preservados solo por historial). Solo un método `active` puede usarse en un cobro nuevo; `requiresReference` también es configuración por método, no una regla fija por código. Desde NR-01, los 5 métodos activos nacen con `requiresReference=false` en el baseline (`prisma/seed.ts`): la referencia es opcional por defecto en todos ellos, sin dejar de ser editable por ADMIN vía `PATCH /payment-methods/:id` (ver §11).
12. **Contabilidad básica** — asientos derivados de ventas, pagos y anulaciones, agrupados en **periodos contables mensuales** (`AccountingPeriod`, Fase A2.1) con ciclo de vida OPEN/CLOSED, **fecha contable** propia por asiento (`AccountingEntry.accountingDate`, zona America/Lima, Fase A2.2) y **numeración secuencial** sin huecos dentro de cada periodo (`AccountingEntry.journalNumber`, Fase A2.3) — ver detalle en §11. El cliente aprobó además (Fase A0, ver §11) un alcance de ROADMAP mucho mayor para este módulo (PCGE —cuyo plan de cuentas jerárquico ya existe desde la Fase A1, ver §11—, asientos manuales, libro diario/mayor, balance de comprobación, compras y cuentas por pagar, multimoneda) — aprobación de dirección estratégica, no autorización para implementar todavía salvo lo ya descrito arriba. Ver §11 para el detalle y §7 para lo que sigue expresamente fuera de alcance mientras no se apruebe cada capacidad puntual.
13. **Reportes** — ventas, cobranzas, inventario, cuentas por cobrar. Los 5 reportes operativos de venta/cobranza/cotización (R2/R3/R4/R8/R9) están restringidos por propiedad del vendedor desde P6-E1 (ver §6 y §11).
14. **Configuración y correlativos** — parámetros del sistema y series de documentos.
15. **Auditoría** — registro de acciones críticas.
16. **Facturación electrónica (demostración)** — emisión de FACTURA/BOLETA sobre ventas confirmadas mediante una abstracción de proveedor (`ElectronicInvoicingProvider`), con `MockElectronicInvoicingProvider` como única implementación existente. Un documento `ACCEPTED` por el proveedor MOCK no tiene validez fiscal ante SUNAT (ver §7). Series fiscales (`FiscalSeries`) separadas de los correlativos comerciales (`DocumentSequence`).
17. **Caja / arqueo de caja — RETIRADO** (decisión del cliente, rama `feat/remove-cash-sessions`). El módulo operativo `CashSessionsModule` y sus 7 endpoints (`/api/v1/cash-sessions/*`) ya no existen: no hay apertura, cierre, arqueo ni aprobación/rechazo de descuadres. Los cobros se registran directamente (ver §6 "Cobros"). Se conservan en el esquema, solo por historial, las tablas `cash_sessions` y `cash_session_payment_method_summaries`, el enum `CashSessionStatus`, la columna nullable `Payment.cashSessionId` (vínculos antiguos intactos) y las acciones de auditoría `CASH_SESSION_*`.

---

## 5. Roles

- `ADMIN` — acceso total, configuración y usuarios. Sin restricción de propiedad en ningún módulo.
- `SELLER` — cotizaciones, ventas, pagos, clientes, comprobantes electrónicos y reportes/dashboard comerciales, pero **restringido a sus propios registros** (`Sale.sellerId`/`Quote.sellerId`) desde P1–P6-E2 (ver §6 "Propiedad y autorización por vendedor" y §11). No tiene acceso a Contabilidad básica ni a Auditoría.
- `WAREHOUSE` — productos, categorías, unidades, inventario. En el Dashboard conserva únicamente la sección `lowStock`; el resto de indicadores comerciales permanece oculto (nunca se calculan para este rol). Sin acceso a Ventas, Cotizaciones, Pagos, Cuentas por cobrar, Comprobantes ni Reportes.
- `MANAGEMENT` — dashboard y reportes (lectura y análisis), con **alcance global sin restricción de propiedad** en todos los módulos de lectura (ventas, cotizaciones, pagos, cuentas por cobrar, comprobantes, reportes, dashboard, Contabilidad básica, Auditoría). **Nunca** adquiere permisos de escritura: no registra ni anula pagos, no emite ni reintenta comprobantes, no modifica ventas ni cotizaciones (ver §11, cierre P6-E4).

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

**Propiedad y autorización por vendedor (P1–P6-E2)**
- La identidad y el rol del solicitante salen **siempre** del rol **ACTIVO** revalidado en vivo por `JwtAuthGuard` (KAN-18) en cada petición — nunca de un dato enviado por el cliente (body/query/headers) ni confiado solo porque el JWT esté firmado.
- `Sale.sellerId` define la propiedad comercial de una **venta**. `Quote.sellerId` define la propiedad de una **cotización**. Una venta confirmada desde cotización hereda el `sellerId` de la cotización original, nunca el del actor que la convierte.
- `Payment.createdByUserId` identifica **quién registró el cobro**, nunca al propietario de la venta cobrada: el alcance de un pago siempre se decide por `Payment → Sale.sellerId`. Un ADMIN puede cobrar la venta de un SELLER y ese cobro sí pertenece al dashboard/reportes/listado de ese SELLER; un cobro histórico que un SELLER haya registrado sobre una venta ajena nunca aparece en lo que ese SELLER puede ver.
- Las policies puras `src/sales/sale-access.policy.ts` (`Sale.sellerId`) y `src/quotes/quote-access.policy.ts` (`Quote.sellerId`) son la única fuente de estas reglas; no existe una tercera policy — los módulos que necesitan alcance por venta (Pagos, Cuentas por cobrar, Comprobantes, Reportes, Dashboard) reutilizan la de Ventas a través de la relación hacia `Sale`, nunca duplican el criterio.
- En listados, reportes y agregaciones, el alcance se aplica **dentro** de la consulta Prisma/SQL (en el `WHERE`, antes de `GROUP BY`/`SUM`/`COUNT`/`aggregate()`/`take`) — nunca calculando un resultado global para filtrarlo o restarle algo después.
- Un filtro opcional enviado por el cliente (por ejemplo `sellerId` en los reportes) se combina con el alcance obligatorio mediante **AND**, nunca lo sustituye ni lo amplía con OR: un `sellerId` ajeno produce un resultado vacío, no los datos de otro vendedor.
- Donde el endpoint opera sobre un **recurso único** (detalle, impresión, entrega/observación de venta, operaciones de cotización, emisión de comprobante), una referencia ajena responde el **mismo HTTP 404** que una inexistente, con idéntico mensaje — nunca 403 (que revelaría que el recurso existe). Esto NO aplica a los endpoints de **listado o agregación** (pagos, cuentas por cobrar, reportes, dashboard): ahí el registro ajeno simplemente queda excluido del conjunto o del cálculo, sin ningún error.
- Una operación denegada por propiedad **no produce ningún efecto persistente**: no crea ni modifica filas, no consume correlativos ni numeración fiscal, no genera auditoría de éxito.
- La **atribución comercial** (`sellerId`, quién es dueño del documento) y el **actor de auditoría** (`actorUserId`/`createdByUserId`, quién ejecutó la acción) son conceptos distintos: la auditoría siempre registra al actor real, incluso cuando ADMIN opera sobre una venta de un SELLER.
- ADMIN y MANAGEMENT consultan sin esta restricción (alcance global) en todos los módulos listados en §5; MANAGEMENT nunca la combina con permisos de escritura. WAREHOUSE no participa de este requerimiento (sin acceso a los módulos comerciales afectados).
- Detalle módulo por módulo, cronología de bloques (P1–P6-E2) y decisiones todavía pendientes: ver §11.

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

> **Nota (Fase A0, ver §11):** el cliente aprobó un roadmap de Contabilidad empresarial (PCGE, periodos, libros, compras/cuentas por pagar, multimoneda) que algún día alcanzará varios puntos de esta lista (Compras y proveedores, Kardex valorizado, Multi-moneda). Esa aprobación es de **dirección estratégica**, no de implementación: cada capacidad sigue fuera de alcance hasta que se apruebe puntualmente y se implemente en una fase dedicada. Un futuro módulo de Importaciones (no iniciado) dependerá de esa base contable. Facturación electrónica SUNAT real, Alquileres, CRM avanzado, Ecommerce, Aplicación móvil e Integraciones externas no forman parte de este roadmap y siguen fuera de alcance sin excepción.

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

**Requerimiento de propiedad por vendedor (P1–P6-E2, rama
`feat/seller-sale-ownership`, base `main` en `13e74a2`):** implementado y
verificado sobre el código real (controllers/services/policies), **sin
commit, push ni PR todavía** — pendiente de autorización explícita del
cliente para P7-C. Reemplaza por completo la decisión pendiente anterior
("vendedor solo ve sus ventas"), que ya está implementada. Policies nuevas
y reutilizadas en todo el requerimiento: `src/sales/sale-access.policy.ts`
(`Sale.sellerId`) y `src/quotes/quote-access.policy.ts` (`Quote.sellerId`);
ver §6 "Propiedad y autorización por vendedor" para la semántica exacta.

- **P1** — policy de propiedad de ventas (`sale-access.policy.ts`): alcance
  de lectura (`saleReadScopeWhere`) y de operación (`canOperateSale`/
  `assertCanOperateSale`) por rol, como fundamento puro reutilizable —
  todavía sin conectar a ningún endpoint en este bloque.
- **P2** — `GET /sales`, `GET /sales/:id`, `GET /sales/:id/print`: primera
  conexión real de la policy; SELLER restringido a `Sale.sellerId =
  requester.id`; venta ajena e inexistente responden el mismo 404 "Venta no
  encontrada".
- **P3** — `POST /sales/:id/mark-delivered`: misma restricción, aplicada
  dentro de la transacción sobre la fila ya bloqueada (`FOR UPDATE`, con
  `seller_id` en el `SELECT`).
- **P4** — `POST /sales/:saleId/payments*`: la comprobación de propiedad en
  los cobros posteriores se realiza desde `PaymentsService.register()`/
  `cancel()`, utilizando la venta bloqueada (`SELECT ... FOR UPDATE`) y la
  policy correspondiente, antes de delegar en `PaymentEngine`. Un cobro
  sobre una venta ajena queda bloqueado. `PaymentEngine` no fue modificado
  por este requerimiento.
- **P5** — `GET /payments` y `GET /accounts-receivable`: alcance por
  `Payment → Sale.sellerId` (nunca `Payment.createdByUserId`).
- **P6-A** — `POST /sales/from-quote/:quoteId` con pago inicial: la
  conversión de una cotización ajena queda bloqueada (`assertCanOperateQuote`
  antes de cualquier efecto); la venta resultante hereda `Quote.sellerId`.
- **P6-B1/B2** — `quote-access.policy.ts`: `GET /quotes`, `GET /quotes/:id`,
  `GET /quotes/:id/print` (B1) y `PATCH/accept/reject` (B2) restringidos a
  `Quote.sellerId = requester.id`, mismo criterio de 404 indistinguible.
- **P6-C1/C2** — Comprobantes electrónicos: lectura (`GET
  /electronic-documents*`, C1) y emisión (`POST
  /sales/:saleId/electronic-documents`, C2) restringidas a la venta propia;
  el reintento (`POST /electronic-documents/:id/retry`) permanece
  exclusivo de ADMIN, sin cambios.
- **P6-D** — `POST /sales/:id/mark-observed`: misma restricción que P3,
  reutilizando `transitionDelivery()`.
- **P6-E1** — Los 5 reportes operativos (`sales-by-product`,
  `sales-by-customer`, `sales-by-seller`, `quotes-by-status`,
  `payments-by-method`) restringidos por vendedor; el filtro `sellerId`
  opcional se combina con AND, nunca sustituye el alcance.
- **P6-E2** — `GET /dashboard`: las secciones `sales`/`collections`/
  `quotes`/`receivables` restringidas por vendedor (incluido el top 5 de
  cuentas por cobrar, acotado ANTES del límite); `lowStock` sin cambios.
- **P6-E3/P6-E4** — Auditoría de cierre: `GET /users/lookup` (identidad
  mínima, sin datos comerciales) y los permisos de MANAGEMENT ya cumplían
  la regla aprobada; cerrados **sin cambios de código**.

Evidencia de la última validación completa: **84 suites / 2939 pruebas
unitarias**; **31 suites / 1250 pruebas E2E en dos ejecuciones consecutivas**
(exit code 0 ambas); `lint:check` y `build` correctos.

**NR-01 — referencia de pago opcional por defecto** (rama
`feat/optional-payment-references`, **fusionada a `main` vía PR #25**):
los 5 métodos de pago activos (`CASH`, `CARD`,
`TRANSFER`, `YAPE`, `PLIN`) nacen con `requiresReference=false` en el
baseline (`SEED_PAYMENT_METHODS`, `prisma/seed.ts`) — antes solo `CASH` lo
tenía así; los 4 métodos legacy inactivos no cambian. La referencia sigue
siendo editable por método en cualquier momento vía ADMIN (`PATCH
/api/v1/payment-methods/:id`), y el motor (`PaymentEngine.register()`,
`assertReferenceRequiredForMethod()`) sigue exigiéndola sin excepción
cuando `requiresReference=true` para cualquier método (baseline o
personalizado) — ningún archivo de dominio fue modificado, solo el dato
baseline. `seedPaymentMethods()` sigue usando `upsert` con `update: {}`:
este cambio de seed **nunca actualiza automáticamente** una base ya
seedeada (incluida `pos_db`, demo o producción); para una instalación
existente, aplicar el nuevo baseline requiere una acción ADMIN separada
(el mismo `PATCH` por método) — no ocurre por desplegar este cambio ni por
reejecutar el seed. No se modificó ningún dato histórico (`Payment.reference`
de pagos ya registrados queda intacto).

**NR-04 — alertas de stock bajo** (rama `feat/low-stock-alerts`,
**fusionada a `main` vía PR #28**): corrige una nota
desactualizada de este documento — el umbral de stock bajo configurable por
producto (`Product.stockMinimum`, `GET /inventory/low-stock`) ya existía
desde la Fase 9, Bloque A (R5/R6), bien probado y documentado en código,
pero esta sección seguía listándolo como pendiente. NR-04 reutiliza esa
arquitectura por completo (sin umbral global ni tabla nueva) y añade
únicamente una clasificación derivada `stockStatus` (`NORMAL`/`LOW_STOCK`/
`OUT_OF_STOCK`, nunca persistida, calculada en `src/inventory/stock-status.ts`)
expuesta en `GET /inventory/low-stock`, y un default de 3 unidades para
`stockMinimum` cuando `POST /products` lo omite en un producto inventariable
nuevo (los productos SERVICE/no inventariables siguen naciendo en 0; ningún
producto ya existente se ve afectado).

**Fase A0 — ampliación de alcance de Contabilidad y dureza de integridad
financiera** (rama `feat/accounting-a0-hardening`, base `main` en `eec645c`,
**implementada y validada, sin commit/push/PR todavía** — pendiente de
autorización explícita del cliente):

- **Aprobación de dirección estratégica.** El cliente aprobó ampliar
  DemoSystem POS de precontabilidad básica a un módulo de Contabilidad
  empresarial completo, usando el ERP peruano ContaNet únicamente como
  referencia FUNCIONAL — nunca como integración ni código a copiar. El
  roadmap aprobado (PCGE, periodos contables, asientos manuales, libro
  diario/mayor, balance de comprobación, compras y cuentas por pagar,
  tesorería, multimoneda; un futuro módulo de Importaciones después de esa
  base) es una aprobación de **dirección**, no de implementación: ninguna
  de esas capacidades existe todavía en el código, y cada una requiere su
  propio plan aprobado antes de escribirse. `AccountingEngine`
  (`src/accounting/accounting.engine.ts`) sigue siendo el ÚNICO motor de
  posteo contable; A0 no introduce un segundo escritor ni modifica su
  comportamiento existente. Las políticas contables/tributarias de detalle
  requieren validación de un contador peruano antes de implementarse.
- **A0.2 — protección de cambio de moneda.** `ConfigurationService.
  updateConfiguration()` (`src/configuration/configuration.service.ts`)
  rechaza con 409 un cambio de `CompanySettings.currencyCode` a un valor
  DISTINTO del vigente en cuanto ya existe al menos una `Sale` o un
  `AccountingEntry` (sin filtrar por estado: un registro `CANCELLED`
  también es historia real). El chequeo corre dentro de la misma
  transacción del PATCH, como el último paso antes del `UPDATE`.
  Reenviar la misma moneda ya vigente sigue funcionando como no-op; no se
  introduce multimoneda ni conversión alguna.
- **A0.3 — protección de anulación con comprobante ACEPTADO.**
  `SalesService.cancel()` (`src/sales/sales.service.ts`) rechaza con 409,
  ANTES de cualquier mutación (stock, pagos, contabilidad, auditoría), la
  anulación de una venta con un `ElectronicDocument` en estado `ACCEPTED`
  — este sistema no implementa notas de crédito. El resto de las reglas de
  anulación (venta ya `CANCELLED`, motivo obligatorio, reversión de stock
  y contabilidad) queda intacto.
- **Compatibilidad de pruebas existentes.** 4 pruebas e2e preexistentes
  asumían un comportamiento que A0 vuelve inválido a propósito: 3 en
  `test/configuration-tax.e2e-spec.ts` §46 (cambiaban `currencyCode` en
  vivo con historia financiera ya creada por la misma suite — ahora fijan
  la moneda como fixture vía escritura directa de Prisma, igual criterio
  que `withTemporarilyRemovedAccount()` en `accounting.e2e-spec.ts`) y 1
  en `test/electronic-invoicing-api.e2e-spec.ts` (R2-B6: anulaba una venta
  con comprobante `ACCEPTED` — ahora confirma el 409 explícitamente y
  continúa probando el resto del caso con la venta `ACTIVE`). Se agregaron
  además pruebas unitarias y e2e dedicadas para ambos casos (aceptado y
  rechazado) de A0.2/A0.3.
- **Revisión previa al commit — cierre de condición de carrera (A0.2).**
  El guardia original de A0.2 comprobaba Sale/AccountingEntry SIN ningún
  lock: bajo READ COMMITTED (el nivel por defecto de Prisma, sin cambios
  en A0), una venta directa confirmándose en paralelo podía quedar
  invisible para el guardia y comprometerse DESPUÉS de que el cambio de
  moneda ya decidiera "sin historia" — exactamente el estado mixto que
  A0.2 existe para impedir. Cerrado con un lock explícito simétrico
  (`SELECT ... FOR UPDATE` sobre la fila singleton de `company_settings`)
  en ambos lados: `ConfigurationService.updateConfiguration()` (solo
  cuando el PATCH incluye `currencyCode`) y `SalesService.createDirect()`
  (siempre, antes de leer `currencyCode` para el snapshot de la venta;
  `createFromQuote()` no lo necesita — copia el snapshot ya congelado de
  la cotización, nunca relee `CompanySettings`). Verificado con una
  prueba de concurrencia real (dos peticiones HTTP en paralelo contra
  Postgres real, mismo patrón que `accounting.e2e-spec.ts` §68-§73) en
  `test/configuration-tax.e2e-spec.ts` §47, estable en 4 ejecuciones.
- **Revisión previa al commit — robustez de fixtures E2E.** Los 3 tests
  de `test/configuration-tax.e2e-spec.ts` §46 que fijan `currencyCode`
  como fixture ahora envuelven su cuerpo en `try/finally`: antes, un
  `expect()` fallido a mitad de prueba dejaba la moneda en `USD` para el
  resto de la corrida completa (archivos ajenos incluidos), y A0.2 ya
  impedía que el `afterAll` de ese mismo archivo la revirtiera por la vía
  normal (PATCH) una vez creada la historia financiera de la suite.
  `createTestPrismaClient()`/`jest-e2e.setup.ts` ya verificaban (sin
  relación con A0) que estos escrituras directas de Prisma solo pueden
  apuntar a `pos_db_test`, nunca a `pos_db`.
- **Cierre final — A0.3, decisión del cliente: opción B.** El hallazgo
  anterior (carrera emisión vs. anulación, `persistProviderOutcome()`
  nunca revisaba si la venta había sido anulada mientras tanto) quedó
  **corregido**, no solo documentado:
  - `SalesService.cancel()` ahora rechaza (409) con un comprobante
    primario en `CREATED`, `SUBMITTED`, `SUBMISSION_FAILED` o `ACCEPTED`
    — solo `REJECTED` permite anular (es terminal: ningún camino de
    reintento existe desde `REJECTED`, y el índice único parcial
    `electronic_documents_one_primary_per_sale` garantiza que nunca haya
    un segundo documento primario en paralelo).
  - `ElectronicDocumentsService.createFiscalDocument()` (Fase 1 de
    `issue()`) toma el MISMO lock de la venta (`SELECT ... FOR UPDATE`)
    antes de leerla, simétrico con `SalesService.cancel()` (`lockSale()`).
    Esto cierra el único hueco real: el intervalo ANTES de que exista
    cualquier fila `ElectronicDocument` (una vez que existe, con
    cualquier estado bloqueante, `cancel()` ya la encuentra con una
    lectura plana sin necesitar lock adicional). Ninguna transacción
    queda abierta esperando al proveedor externo (sin cambios ahí).
  - Verificado con una prueba de concurrencia real (dos peticiones HTTP
    en paralelo — emitir comprobante vs. anular la misma venta — contra
    Postgres real) en `test/electronic-invoicing-api.e2e-spec.ts`, más
    pruebas deterministas para cada estado (`SUBMISSION_FAILED` bloquea,
    `REJECTED` permite, vía proveedores de prueba dedicados).
- **Cierre final — riesgo confirmado en la conversión Cotización -> Venta
  (tarea 2).** `Quote.currencyCode` nunca participaba en el guardia de
  A0.2 (que solo mira `Sale`/`AccountingEntry`), así que era posible:
  1) cotización creada en PEN, 2) sin historia financiera todavía, 3) la
  moneda de la empresa cambia a USD (A0.2 lo permite, correctamente, no
  hay historia que lo bloquee), 4) la conversión de esa cotización crea
  una `Sale`/`AccountingEntry` en PEN mientras `CompanySettings` ya dice
  USD — el mismo estado mixto que A0.2 existe para impedir, alcanzado
  por una vía distinta. **Corregido**: `SalesService.createFromQuote()`
  ahora compara `Quote.currencyCode` contra la moneda vigente (tomando
  el MISMO lock de `company_settings` que A0.2) y rechaza la conversión
  con 409 si difieren, sin convertir ni reescribir ningún monto ni la
  cotización histórica. Verificado en
  `test/configuration-tax.e2e-spec.ts` §48 (caso bloqueado y caso
  permitido); la concurrencia específica moneda-vs-conversión reutiliza
  el mismo primitivo de lock ya validado por la prueba de concurrencia
  real de A0.2 (§47) — no se duplicó un segundo escenario de carrera de
  bajo valor en un archivo cuya historia financiera compartida ya
  garantiza que el PATCH de moneda pierda siempre frente a ventas
  previas de la misma suite.
- **Validación final:** 88 suites / 3107 pruebas unitarias; 31 suites /
  1332 pruebas E2E en dos ejecuciones consecutivas (exit code 0 ambas);
  `lint:check` y `build` correctos. Sin cambios de esquema ni migración
  nueva (A0 es exclusivamente lógica de servicio sobre tablas existentes).

**Fase A2 — periodos contables, fecha contable y numeración de asientos**
(rama `feat/accounting-a2-periods`, base `main` en `795b1f0`, **implementada
y validada, sin commit/push/PR todavía** — pendiente de autorización
explícita del cliente; migración aplicada EXCLUSIVAMENTE en `pos_db_test`,
nunca en `pos_db`). Construye sobre A1 (plan de cuentas jerárquico PCGE,
ya fusionado a `main` vía PR #31) la base técnica reutilizable para A3
(libro diario/mayor, balance de comprobación): `AccountingEngine` sigue
siendo el ÚNICO escritor de `AccountingEntry`/`AccountingEntryLine`; A2 no
introduce un segundo escritor ni reemplaza su comportamiento existente de
SALE/PAYMENT.

- **A2.1 — Periodos contables mensuales.** Modelo nuevo `AccountingPeriod`
  (`year`+`month` únicos, `status` `OPEN`/`CLOSED`, `lastJournalNumber`
  como contador transaccional). Administración EXPLÍCITA (listar, detalle,
  abrir/crear por adelantado, cerrar, reabrir) vía
  `GET/POST /api/v1/accounting/periods`,
  `POST /api/v1/accounting/periods/:id/close`,
  `POST /api/v1/accounting/periods/:id/reopen` — ADMIN administra,
  MANAGEMENT solo lee, SELLER/WAREHOUSE sin ningún acceso (mismo criterio
  que el resto del dominio contable). Distinta de la auto-creación
  IMPLÍCITA: `AccountingEngine` crea automáticamente, dentro de su propia
  transacción de posteo, el periodo del mes en curso como `OPEN` la primera
  vez que lo necesita (`INSERT ... ON CONFLICT (year, month) DO NOTHING`,
  atómico y seguro bajo dos transacciones concurrentes) — la actividad
  comercial normal nunca se bloquea porque nadie inicializó manualmente el
  mes vigente. Un periodo `CLOSED` nunca se reabre automáticamente: siempre
  requiere `POST .../reopen` explícito y auditado (`ACCOUNTING_PERIOD_
  OPENED`/`CLOSED`/`REOPENED`); la auto-creación implícita nunca audita por
  sí misma (ya queda evidenciada por el `ACCOUNTING_ENTRY_POSTED` del
  asiento que la disparó).
- **A2.2 — Fecha contable.** `AccountingEntry.accountingDate` (`@db.Date`,
  nueva) se deriva siempre de `postedAt` (el mismo instante factual ya
  existente: `Sale.confirmedAt`/`Payment.paidAt`/el instante de una
  anulación) en la zona de negocio única del MVP, **America/Lima**,
  reutilizando `businessToday()`/`toPrismaDate()` de
  `common/date/business-date.ts` (ya usadas por los filtros de rango de
  `GET /accounting/entries`) en vez de un segundo cálculo de huso horario
  paralelo. `postedAt` conserva su significado histórico sin cambios. Un
  asiento REVERSAL usa la fecha contable de SU PROPIO `postedAt` (el
  instante de la anulación), nunca la del asiento ORIGINAL que revierte.
  Ninguna API comercial permite retrofechar: `postedAt` siempre es
  `new Date()` generado por el backend en el instante de la operación,
  nunca un valor enviado por el cliente — invariante preexistente, sin
  cambios en A2.
- **A2.3 — Numeración secuencial.** `AccountingEntry.journalNumber`, único
  y sin huecos **dentro de su periodo** (`@@unique([periodId,
  journalNumber])`, nunca global), asignado mediante el mismo patrón
  transaccional ya usado por `DocumentSequenceService.next()`: un único
  `UPDATE accounting_periods SET last_journal_number = last_journal_number
  + 1 ... WHERE id = ? AND status = 'OPEN' RETURNING last_journal_number`
  dentro de la misma transacción que crea el asiento — nunca una secuencia
  de PostgreSQL (`CREATE SEQUENCE`), cuyo `nextval()` no revertiría junto
  con un `ROLLBACK` y dejaría huecos en la numeración ya comprometida. El
  mismo `UPDATE` resuelve a la vez la validación "periodo OPEN" (0 filas
  `RETURNING` -> 409) y el lock de concurrencia (ver A2.4). Un asiento
  REVERSAL recibe su propio número, nunca reutiliza el del ORIGINAL. Sin
  edición manual posible.
- **A2.4 — Integración con AccountingEngine y concurrencia.**
  `AccountingEngine` resuelve periodo+fecha contable+número dentro de
  `postOriginal()`/`reverseOriginalForSource()`, antes del `INSERT` del
  asiento, con el `tx` del llamador (SalesService/PaymentEngine, sin
  cambios en su forma de invocar al motor). Garantías de concurrencia,
  todas basadas en locking de fila de PostgreSQL (READ COMMITTED, sin
  locks adicionales ni nuevos puntos de deadlock con los locks existentes
  de Sale/company_settings):
  - *Posteo vs. cierre del mismo periodo*: el `UPDATE` condicionado a
    `status='OPEN'` serializa contra el `UPDATE status=CLOSED` del cierre
    — cualquiera que tome el lock de la fila primero gana; nunca un
    asiento nuevo comprometido después de que el periodo ya cerró.
  - *Dos posteos simultáneos en el mismo periodo*: PostgreSQL serializa
    ambos `UPDATE` sobre la misma fila; números consecutivos, nunca
    duplicados.
  - *Reversión vs. cierre*: mismo mecanismo exacto (la reversión también
    pasa por `resolvePeriodAndAssignNumber()`).
  - *Creación concurrente del mismo periodo nuevo*: `INSERT ... ON
    CONFLICT DO NOTHING` es atómico; ninguna de las dos transacciones
    falla ni duplica la fila.
  Las cuatro verificadas con pruebas E2E reales contra PostgreSQL (ver
  abajo), no con mocks.
- **A2.5 — Migración e historial.** Migración 100% aditiva y editada a
  mano (mismo criterio que A1):
  `accounting_date`/`period_id`/`journal_number` nacen NULLABLE, se
  completan con un backfill determinista y solo entonces se vuelven
  `NOT NULL`. Backfill (no-op exacto hoy: 0 filas históricas en `pos_db`/
  `pos_db_test`, pero escrito para ser correcto contra un historial real
  poblado — nunca se asume que una base vacía representa el caso general):
  `accounting_date` se deriva de `posted_at` ya persistido vía
  `(posted_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Lima'`; se crea un
  periodo `OPEN` por cada `(year, month)` distinto ya presente en el
  historial; `journal_number` se asigna con el mismo criterio de desempate
  ya usado en el resto del dominio (`posted_at ASC, id ASC`). Los 6
  registros de sistema de `chart_of_accounts` y todo el historial de
  `accounting_entries`/`accounting_entry_lines` quedan intactos — ninguna
  fila existente se reescribe ni se elimina.
  - **Decisión tomada (la más segura por defecto, sin validación de
    contador todavía):** todo periodo creado por el backfill nace `OPEN`,
    nunca `CLOSED` automáticamente — cerrar un periodo histórico es una
    decisión de negocio explícita de ADMIN que esta migración no debe
    asumir por sí misma (ver decisiones pendientes).
- **A2.6 — Endpoints.** `GET/POST /api/v1/accounting/periods`,
  `GET /api/v1/accounting/periods/:id`,
  `POST /api/v1/accounting/periods/:id/close`,
  `POST /api/v1/accounting/periods/:id/reopen` (ver A2.1 para roles).
  `GET /api/v1/accounting/entries*` ahora incluye `accountingDate`
  (string `YYYY-MM-DD`), `periodId` (uuid) y `journalNumber` (entero) —
  aditivo, retrocompatible; ningún campo existente cambia de forma.
  `GET /api/v1/accounts` (legado, Fase 8) y el resto de la superficie de
  Ventas/Pagos/Cotizaciones no cambian de contrato. Libro diario/mayor y
  balance de comprobación NO se implementan todavía (quedan para A3, igual
  que indica el kickoff aprobado).
- **Validación:** 97 suites / 3244 pruebas unitarias (+9 suites/+43 sobre
  el baseline de A1); 32 suites E2E incluyendo la nueva
  `test/accounting-periods.e2e-spec.ts` (RBAC, ciclo de vida OPEN/CLOSED,
  integración con una venta real, y 4 pruebas de concurrencia real contra
  PostgreSQL: numeración concurrente, posteo vs. cierre, reversión vs.
  cierre, creación concurrente del mismo periodo nuevo vía integración
  directa con `AccountingEngine` + `PrismaService` reales); regresión
  completa de la suite E2E preexistente (ventas, pagos, contabilidad,
  plan de cuentas, configuración/IGV) sin romper ningún comportamiento
  previo; `lint:check` y `build` correctos.

**Decisiones funcionales todavía pendientes (NO implementadas; distintas del
requerimiento de propiedad por vendedor, ya cerrado arriba):** crédito
opcional; descuentos por producto;
descuentos en soles o porcentaje; exportaciones a Excel; Libro Diario y Libro Mayor como
reportes contables terminados (hoy solo existen los asientos básicos de
Contabilidad básica, §4 punto 12); reportes contables adicionales; módulo de
importaciones y proveedores; cualquier cambio futuro que amplíe los permisos
de facturación/escritura de MANAGEMENT (su alcance actual —lectura global,
cero escritura— es la decisión vigente, confirmada en el cierre P6-E4);
**(Fase A2)** si los periodos contables backfilleados a partir de
historial real deberían nacer `CLOSED` en vez de `OPEN` (decisión tomada
por defecto: `OPEN`, ver §11 A2.5 — requiere validación de un contador
antes de cambiarse); política formal de cierre periódico recurrente
(mensual/anual) una vez exista un calendario contable real; rol
`ACCOUNTANT` dedicado (seguirá diferido hasta Fase A3 o posterior).

**Riesgos técnicos conocidos:** varias suites E2E dejan residuos en
`products` y `audit_logs`, y el cliente genérico del seed de pruebas no se
conserva al terminar (la suite pasa igualmente dos veces seguidas, pero el
aislamiento global no está completamente resuelto); 11 errores preexistentes
en `tsc --noEmit`; el frontend todavía depende de Caja; no hay CI en GitHub.

Migraciones totales: **19** (conteo corregido; esta sección no reflejaba
todavía la migración 18 de la Fase A1 —plan de cuentas jerárquico PCGE,
ya en `main`— ni la 19, de la Fase A2 arriba, aplicada hoy EXCLUSIVAMENTE
en `pos_db_test`, todavía pendiente en `pos_db` y en `main`). Sin cambios
de esquema por el requerimiento de propiedad por vendedor ni por la Fase
A0: ambos son exclusivamente de autorización/lógica de servicio.

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

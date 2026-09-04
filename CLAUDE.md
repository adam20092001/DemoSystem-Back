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
9. **Cotizaciones** — propuestas comerciales, sin efecto sobre stock.
10. **Ventas / POS** — registro y confirmación de ventas.
11. **Pagos** — cobros aplicados a ventas, control de saldo pendiente. El método de pago (`method`) es un código dinámico administrado por ADMIN (`PaymentMethodsModule`, `GET/POST/PATCH /api/v1/payment-methods`), no un enum fijo: cada `Payment` resuelve y snapshotea el método (código, nombre, si afecta caja) en el instante del cobro, así que un método renombrado o desactivado después nunca altera pagos ya registrados. Baseline inicial: `CASH`/`CARD`/`TRANSFER`/`YAPE`/`PLIN` activos; `BANK_TRANSFER`/`BANK_DEPOSIT`/`DIGITAL_WALLET`/`OTHER` inactivos (preservados solo por historial). Solo un método `active` puede usarse en un cobro nuevo; `requiresReference` también es configuración por método, no una regla fija por código.
12. **Contabilidad básica** — asientos derivados de ventas, pagos y anulaciones.
13. **Reportes** — ventas, cobranzas, inventario, cuentas por cobrar.
14. **Configuración y correlativos** — parámetros del sistema y series de documentos.
15. **Auditoría** — registro de acciones críticas.
16. **Facturación electrónica (demostración)** — emisión de FACTURA/BOLETA sobre ventas confirmadas mediante una abstracción de proveedor (`ElectronicInvoicingProvider`), con `MockElectronicInvoicingProvider` como única implementación existente. Un documento `ACCEPTED` por el proveedor MOCK no tiene validez fiscal ante SUNAT (ver §7). Series fiscales (`FiscalSeries`) separadas de los correlativos comerciales (`DocumentSequence`).
17. **Caja / arqueo de caja (Ticket B post-MVP)** — cada cobrador (`ADMIN`/`SELLER`) opera su propia `CashSession` (`CashSessionsModule`, `POST/GET /api/v1/cash-sessions/*`), abierta siempre manualmente; como máximo una sin resolver (`OPEN`/`PENDING_APPROVAL`) por usuario. Todo `Payment` nuevo exige que el cobrador tenga su caja `OPEN` (`PaymentEngine.register()`, vía `CashSessionReader` compartido) y se vincula a ella automáticamente — la exigencia es por acción, nunca por rol fijo ni por si el método afecta el cajón físico. Ver §6 para las reglas críticas exactas del cierre/aprobación/rechazo.

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

**Documentos y datos**
- Los **correlativos se generan en el backend, dentro de una transacción** (nunca en el cliente, nunca fuera de transacción).
- Se guardan **snapshots del producto** (código, nombre, precio, unidad, impuestos) en cotizaciones y ventas: los cambios posteriores del catálogo no alteran documentos emitidos.
- **No se eliminan físicamente** registros con historial; se desactivan o anulan (borrado lógico).

**Caja (arqueo)**
- Todo **`Payment` nuevo exige que el cobrador tenga su propia `CashSession` `OPEN`** (regla por acción, evaluada en `PaymentEngine.register()`), sin importar el método de pago ni si `affectsCashDrawer` es `true` o `false`; sin caja abierta, o con la caja en `PENDING_APPROVAL`, el cobro falla (409) y `Payment.cashSessionId` nunca lo controla el cliente.
- `expectedCashAmount = openingAmount + SUM(Payment ACTIVE vinculado con paymentMethodAffectsCashDrawer=true)`, siempre a partir del **snapshot** del método al momento del cobro, nunca del `PaymentMethod` actual.
- Un cierre sin descuadre pasa a `CLOSED` directo; un cierre con descuadre exige `closingObservation` y pasa a `PENDING_APPROVAL` (no admite nuevos cobros ni un segundo cierre) hasta que `ADMIN` o `MANAGEMENT` lo apruebe (acepta el snapshot tal cual, sin recalcular) o lo rechace (vuelve a `OPEN`, snapshot limpiado; el operador puede cerrar de nuevo con datos frescos).
- **Nadie puede aprobar ni rechazar el descuadre de su propia caja**, sin importar su rol activo (regla de identidad, no de rol).
- Una caja `CLOSED` es **inmutable**: anular un `Payment` ya vinculado después no recalcula ni altera su snapshot (montos ni desglose por método).

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
(Caja) es una incorporación post-MVP posterior, detallada más abajo.

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
reapertura desde `CLOSED`. Ver §6 para las reglas críticas exactas.
Migraciones totales: **14**.

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

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
  prisma/                          # PrismaService y módulo
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
11. **Pagos** — cobros aplicados a ventas, control de saldo pendiente.
12. **Contabilidad básica** — asientos derivados de ventas, pagos y anulaciones.
13. **Reportes** — ventas, cobranzas, inventario, cuentas por cobrar.
14. **Configuración y correlativos** — parámetros del sistema y series de documentos.
15. **Auditoría** — registro de acciones críticas.

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

**Transversales**
- Los **roles y permisos se validan desde el backend**.
- Las **operaciones críticas usan transacciones** (`prisma.$transaction`): venta, anulación, pago, correlativo, movimiento de inventario, asiento contable.
- Las **acciones críticas generan auditoría** (quién, qué, cuándo, sobre qué entidad).
- Los **asientos contables deben cuadrar**: total debe = total haber; si no cuadra, la transacción se revierte.

---

## 7. Fuera del alcance del MVP

No implementar, ni preparar abstracciones anticipadas para:

- Alquileres
- Facturación electrónica SUNAT
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
docs/Documento_Maestro_POS_Gestion_Comercial_MVP.docx.docx
```

> Nota: el archivo actualmente tiene la extensión `.docx` duplicada en su nombre.
> Es la referencia funcional oficial; ante conflicto entre este CLAUDE.md y el documento,
> prevalece el documento maestro y debe actualizarse este archivo.

---

## 11. Estado actual del repositorio

A la fecha de creación de este archivo, el proyecto es un **scaffold base de NestJS 11** recién inicializado:

- Existe: `src/app.module.ts`, `src/app.controller.ts`, `src/app.service.ts`, `src/main.ts`, `test/`.
- **Aún no existen**: Prisma (`prisma/schema.prisma`), Swagger, autenticación JWT, Docker/Docker Compose, `.env.example`, ni ninguno de los 15 módulos del MVP.

Orden de construcción sugerido (confirmar antes de ejecutar):

1. Configuración base: variables de entorno, `ValidationPipe`, filtro de excepciones, Swagger, Docker Compose con PostgreSQL.
2. Prisma + esquema inicial + migración.
3. Autenticación y usuarios/roles (guards y decoradores de rol).
4. Catálogo: categorías, unidades, productos.
5. Inventario (movimientos y saldo).
6. Clientes (incluido Público general).
7. Cotizaciones.
8. Ventas/POS + correlativos + auditoría.
9. Pagos.
10. Contabilidad básica.
11. Reportes y dashboard.
12. Configuración del sistema.

---

## 12. Comandos

```bash
npm run start:dev     # desarrollo con watch
npm run build         # compilar
npm run start:prod    # ejecutar build
npm run lint          # ESLint con --fix
npm run format        # Prettier
npm test              # pruebas unitarias
npm run test:cov      # cobertura
npm run test:e2e      # pruebas e2e
```

Comandos previstos al integrar Prisma:

```bash
npx prisma migrate dev --name <nombre>
npx prisma generate
npx prisma studio
```

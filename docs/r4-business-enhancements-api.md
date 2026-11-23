# R4 — Incoterm, compras multimoneda, importación vinculada a compra, países y errores por campo — contrato REST para Angular

> **Estado: implementado en la rama `feat/r4-business-enhancements`. NO desplegado.**
> Incluye **4 migraciones nuevas** (36–39) que **no se han aplicado** a `pos_db` ni a `pos_db_test` (solo a PostgreSQL 16
> descartables). Requiere además **R2-ACT (34)** y **R2-C (35)** aplicadas antes. El frontend no se modifica en esta tarea.

Base: `/api/v1`. Autenticación: cookie HttpOnly. **Importes y cantidades siempre como string.** Cuerpos exactos en Swagger (`/api/docs`).

Resumen de cambios que **rompen** a un cliente existente (ver §8): `POST /import-operations` ya no acepta `reference` y exige
`purchaseInvoiceId`; las líneas de embarques de operaciones nuevas exigen `purchaseInvoiceLineId` y una factura `CONFIRMED`; `unitCost` de
una factura en moneda extranjera tiene 6 decimales; los totales de Cuentas por pagar (resumen/antigüedad/conciliación) están en la moneda
de la empresa.

---

## 1. Contrato común de errores (req. 5)

Compatible hacia atrás: `statusCode`, `message` (string **o arreglo**, sin cambio de tipo), `error`, `timestamp`, `path` y `code` (cuando
existe) se conservan. Se **añaden**:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": ["…texto legible…"],
  "code": "VALIDATION_ERROR",
  "kind": "FORM",
  "errors": [
    { "field": "lines[0].quantity", "code": "REQUIRED", "type": "REQUIRED", "message": "quantity should not be empty" },
    { "field": "issueDate", "code": "INVALID_FORMAT", "type": "FORMAT", "message": "…" },
    { "field": "exchangeRate", "code": "EXCHANGE_RATE_REQUIRED", "type": "BUSINESS", "message": "…" }
  ],
  "timestamp": "…", "path": "…"
}
```

| Campo | Significado |
|---|---|
| `kind` | **Siempre presente.** `FORM`: el error se atribuye a uno o más campos (`errors[]` no vacío). `GENERAL`: conflicto general sin campo responsable (sin `errors`). |
| `errors[].field` | Ruta del campo; arreglos con índice: `lines[0].quantity`, `allocations[1].purchaseInvoiceId`. |
| `errors[].type` | `REQUIRED` (falta el dato), `FORMAT` (tipo/formato/propiedad desconocida) o `BUSINESS` (regla de negocio vinculada a un campo). |
| `errors[].code` | Código estable en MAYÚSCULAS. Validación de entrada: `REQUIRED`, `INVALID_FORMAT`, `UNKNOWN_FIELD`. Reglas de negocio: p. ej. `EXCHANGE_RATE_REQUIRED`. |
| `code` (raíz) | `VALIDATION_ERROR` en validación de entrada; el código de la regla en errores de negocio estructurados; ausente en el resto (p. ej. 401). |

Reglas: **400** = entrada inválida; **409** = conflicto de negocio (nunca se cambia el código HTTP para ocultar un conflicto); 401/403/404
conservan su semántica; los 5xx devuelven un mensaje genérico (sin SQL, trazas ni detalles de Prisma). Un error de **formulario** se pinta junto a
cada campo con `errors[]`; un `kind: "GENERAL"` se muestra como aviso general (usar `message`). Los errores de negocio sin un campo claro
siguen llegando como `GENERAL` con su texto de siempre (no se inventan campos).

Cobertura: el pipe global genera `errors[]` en **todos** los módulos (campos obligatorios, formatos, propiedades no declaradas, líneas anidadas a
cualquier profundidad). Los errores de negocio estructurados (con `field`/`code`) cubren Países, Importaciones, Incoterm, Compras multimoneda y Pagos
a proveedores; el resto de reglas de negocio conserva su mensaje y se entrega como `GENERAL`.

---

## 2. Incoterm en embarques (req. 1)

Campos nuevos en **crear** (`POST /import-operations/:id/shipments`), **editar** (`PATCH /import-shipments/:id`), **detalle**
(`GET /import-shipments/:id`), listado (`GET /import-operations/:id/shipments`) y en el reporte de conciliación de embarques
(`GET /import-reports/shipments`, columnas `incoterm`/`incotermNamedPlace`):

| Campo | Tipo | Regla |
|---|---|---|
| `incoterm` | enum | `EXW, FCA, CPT, CIP, DAP, DPU, DDP, FAS, FOB, CFR, CIF`. Sin valor predeterminado. En `PATCH`, `null` limpia incoterm, lugar y versión. |
| `incotermNamedPlace` | string ≤ 150 | **Obligatorio** si hay `incoterm` (lugar o puerto convenido). Sin incoterm, enviarlo es 400. |
| `incotermVersion` | `"2020"` | Opcional: con incoterm y sin versión se asigna `"2020"`. Sin incoterm nunca se asigna. |

- `FAS`, `FOB`, `CFR` y `CIF` **solo** con `transportMode = SEA` (400 con `errors[0].field = "incoterm"` o `"transportMode"` si el cambio de modo es lo que la invalida).
  La compatibilidad se **revalida** al cambiar el modo de transporte.
- Edición solo en `PLANNED` (409 en cualquier otro estado). Embarques históricos: los tres campos `null`. Permisos sin cambio (ADMIN y PURCHASING escriben; MANAGEMENT/ACCOUNTANT leen).
- No genera gastos, stock, valorización ni asientos. Auditoría con el usuario real (`IMPORT_SHIPMENT_CREATED` incluye `incoterm`).
- La base rechaza (CHECK) las combinaciones inválidas aunque se salte la API.

---

## 3. Catálogo compartido de países (req. 4)

Tabla `countries` (clave: código ISO alpha-2 en mayúsculas). **Inicial:** `CN` China, `PE` Perú, `IN` India. Los códigos que ya usaban proveedores o
importaciones históricas se incorporaron como `pendingReview: true` (nombre provisional = el código; sin inventar identidades).

| Operación | Ruta | Roles |
|---|---|---|
| Listar (activos por defecto; `includeInactive=true`, `search`) | `GET /countries` | ADMIN, MANAGEMENT, ACCOUNTANT, PURCHASING, WAREHOUSE, SELLER |
| Consultar | `GET /countries/:code` | ídem |
| **Registrar** | `POST /countries` `{ code, name }` | **ADMIN, PURCHASING** |
| Editar nombre / confirmar revisión (`pendingReview: false`) | `PATCH /countries/:code` | solo ADMIN |
| Activar / desactivar | `POST /countries/:code/activate`, `/deactivate` | solo ADMIN |

- Respuesta: `{ code, name, active, pendingReview, createdByUserId, createdAt, updatedAt }`. Duplicado de código o de nombre (sin distinguir
  mayúsculas): **409** (`errors[0].field` = `code` o `name`). Formato inválido: 400. No existe borrado: un país usado nunca se elimina (FK `Restrict`).
- **Integración:** `suppliers.countryCode` y `import-operations.originCountry/destinationCountry` siguen siendo el **mismo texto de 2 letras**
  en las respuestas, pero ahora deben existir en el catálogo y estar **activos** al **asignarse** (400 `COUNTRY_NOT_FOUND`, 409 `COUNTRY_INACTIVE`).
  Un país desactivado después no impide editar otros datos de documentos históricos que ya lo usan. Alimente los selectores con `GET /countries`.
- **Ampliación de permisos señalada expresamente:** PURCHASING puede **registrar** países nuevos (decisión del propietario, R4). No obtiene edición,
  desactivación ni ningún otro catálogo.

---

## 4. Importación vinculada a una factura de compra (req. 3)

### Crear y consultar
`POST /import-operations` `{ purchaseInvoiceId (obligatorio), originCountry, destinationCountry, description?, externalReference?, notes? }`

- La **referencia** `IMP-AAAA-NNNNNN` (año de negocio, reinicio anual, sin huecos) la genera el servidor; **enviar `reference` es 400** (`UNKNOWN_FIELD`).
  Unicidad garantizada por el correlativo transaccional y por el índice único de base de datos.
- La factura puede estar `DRAFT` o `CONFIRMED` (no `CANCELLED`: 409). **Nunca se confirma automáticamente.** El **proveedor se hereda** de la factura.
- Respuesta (listado y detalle) añade: `purchaseInvoiceId`, `isLegacyUnlinked`, `purchaseInvoice` (`id`, `documentType`, `documentSeries`,
  `documentNumber`, `documentLabel`, `status`, `currencyCode` = moneda del documento, `canAssignLines`, `supplier { id, legalName, documentType,
  documentNumber, countryCode }`). **Solo el detalle** (`GET /import-operations/:id`) añade `invoiceLines[]` con, por línea de la compra:
  `purchaseInvoiceLineId`, `productId`, `productSku`, `description`, `unitCode`, `invoicedQuantity`, `assignedQuantity` (embarques no anulados de **todas** las
  operaciones), `assignedToThisOperationQuantity`, `availableQuantity` (= facturada − asignada), `receivedQuantity` y `pendingReceiptQuantity` (= facturada − recibida).
- Filtros de listado nuevos: `purchaseInvoiceId`, `isLegacyUnlinked`. Varias operaciones pueden colgar de una misma factura; la sobreasignación se controla
  por línea de factura entre todas ellas.

### Embarques de operaciones nuevas
- **Factura `DRAFT`:** no se asignan líneas (409 `PURCHASE_INVOICE_NOT_CONFIRMED`, campo `lines`); un embarque no puede salir a tránsito con factura no `CONFIRMED`.
- Con la factura `CONFIRMED`, cada línea del embarque **debe** referenciar una línea **de esa factura** (`lines[i].purchaseInvoiceLineId` obligatorio; de otra
  factura: 400 `LINE_NOT_IN_OPERATION_INVOICE`), con el producto de la línea, cantidad positiva y disponible (409 si excede lo facturado, incluso bajo concurrencia).
- Completar una importación **no** confirma compras, recibe, mueve stock, genera gastos/asientos ni capitaliza: el cierre logístico sigue separado de la
  recepción física y de la contabilidad.

### Factura vinculada
`POST /purchase-invoices/:id/cancel` responde **409** si hay una operación **no anulada** vinculada (`PURCHASE_INVOICE_HAS_ACTIVE_IMPORT`) o líneas de la factura
en embarques activos de cualquier operación, incluidas las históricas (`PURCHASE_INVOICE_HAS_ACTIVE_SHIPMENT_LINES`), además de las guardias previas por recepciones y pagos.
Primero se anula la importación (o el embarque). Editar un borrador vinculado sigue permitido (no hay asignaciones sobre un borrador).

### Históricas
Las operaciones anteriores (`isLegacyUnlinked: true`, `purchaseInvoiceId: null`) siguen consultables y operables con la regla anterior (vínculo opcional a
cualquier factura `CONFIRMED`); **no se asignó ninguna factura automáticamente**. `GET /import-reports/legacy-operations` (solo lectura; ADMIN, MANAGEMENT,
ACCOUNTANT, PURCHASING) lista cada histórica con `candidateKind` (`NO_INVOICE_LINKS`, `SINGLE_INVOICE`, `MULTIPLE_INVOICES`) y las facturas que sus líneas ya
referencian: base para una regularización explícita futura. `GET /import-reports/operations` (y su `.xlsx`) añade `purchaseInvoiceId`, `isLegacyUnlinked`,
`purchaseInvoiceDocument`, `purchaseInvoiceStatus`, `supplierId`, `supplierLegalName`.

---

## 5. Compras multimoneda (req. 2)

### Política
- **La moneda contable es siempre la de la empresa** (`CompanySettings.currencyCode`; no se asume PEN). Los asientos, la valorización y los saldos del
  libro están en ella; nunca se mezclan importes de dos monedas.
- `exchangeRate` = **unidades de moneda de la empresa por 1 unidad de moneda del documento** (USD 1000 × 3.70 = PEN 3700). Positiva, hasta 8 decimales,
  **manual por documento** (sin tasas externas). Misma moneda ⇒ tasa 1 (enviar otra es 400). Moneda distinta ⇒ tasa obligatoria (400 `EXCHANGE_RATE_REQUIRED`).
- Se guarda `exchangeRateDate` (por defecto la fecha de emisión / de pago). **Se congelan moneda, tasa y fecha al confirmar**; el borrador se corrige con `PATCH`.
- No hay revaluación periódica de saldos, pagos cruzados entre monedas ni cambios de moneda de empresa con historia (siguen bloqueados): ver §9.

### Factura de compra (`/purchase-invoices`)
Entrada: `currencyCode?`, `exchangeRate?`, `exchangeRateDate?` (crear y editar `DRAFT`). `unitCost` y `creditableTaxAmount` van **en la moneda del documento**.
`unitCost`: 2 decimales en la moneda de la empresa (contrato anterior); hasta **6** en moneda extranjera.

Salida — **qué moneda es cada campo:**

| Campo | Moneda |
|---|---|
| `currencyCode` | moneda del DOCUMENTO |
| `baseCurrencyCode` | moneda de la EMPRESA (contable) |
| `exchangeRate`, `exchangeRateDate` | tasa y fecha congeladas al confirmar |
| `subtotal`, `taxAmount`, `totalAmount` | **documento** |
| `baseSubtotal`, `baseTaxAmount`, `baseTotalAmount` | **empresa** (suma de las líneas convertidas) |
| línea: `unitCost`, `taxableBaseAmount`, `taxAmount`, `creditableTaxAmount`, `lineTotal` | **documento** |
| línea: `baseUnitCost`, `baseTaxableBaseAmount`, `baseTaxAmount`, `baseCreditableTaxAmount`, `baseLineTotal` | **empresa** |

Para una factura en la moneda de la empresa los campos sin prefijo `base` valen lo mismo que antes y los `base*` son iguales a ellos.

**Conversión (decimal exacto, HALF_UP a 2 decimales):** cada *componente* de cada línea (base imponible, impuesto, crédito fiscal) se convierte por separado
(`round(original × tasa, 2)`); el total de línea convertido es base + impuesto; los totales de cabecera son la suma de las líneas convertidas (nunca se convierte
el total del documento), de modo que cabecera, líneas y asiento siempre cuadran. Ejemplo (tasa 3.70, USD 1000 + IGV 180 recuperable): base 3700.00, IGV 666.00,
total 4366.00.

**Contabilidad:** `confirm` postea el asiento con los importes convertidos (mismas cuentas por propósito, IGV, periodo y reglas de siempre). **Valorización:**
recepción con el costo convertido a la tasa histórica de la factura; las diferencias cambiarias del pago **no** modifican el costo del inventario.

### Pagos a proveedores (`POST /supplier-payments`) — política A
Un pago tiene **una moneda** y solo se aplica a facturas **del mismo proveedor y de esa misma moneda** (409 `PAYMENT_CURRENCY_MISMATCH`). Entrada nueva:
`currencyCode?` (por defecto la de la empresa), `exchangeRate?` (obligatoria si la moneda ≠ empresa), `exchangeRateDate?`. `amount` y `allocations[].amount` están en la
moneda del pago; la suma de las asignaciones debe ser igual a `amount`. Varias facturas del proveedor en un pago solo si comparten moneda.

Salida: `amount` (moneda del pago), `currencyCode`, `baseCurrencyCode`, `exchangeRate`, `exchangeRateDate`, `baseAmount` (equivalente en la moneda de la empresa) y
`fxDifferenceAmount`; cada asignación: `amount`, **`carryingBaseAmount`** (valor en libros cancelado, a la tasa histórica de la factura, proporcional; la asignación que
**salda** la factura toma exactamente el residuo), **`settledBaseAmount`** (importe pagado, a la tasa del pago; el reparto entre asignaciones deja el residuo de redondeo en la última)
y **`fxDifferenceAmount`** = settled − carrying (**positivo = pérdida, negativo = ganancia**).

Ejemplo: factura USD 1000 a 3.70 (en libros PEN 3700); pago USD 1000 a 3.80 → `baseAmount 3800.00`, diferencia **+100.00** (pérdida):
`Debe Cuentas por pagar 3700.00 · Debe Pérdida por diferencia de cambio 100.00 · Haber Caja/Bancos 3800.00`. A 3.60: `Debe CxP 3700 · Haber Caja 3600 · Haber Ganancia por diferencia de cambio 100`.

**Mapeos nuevos (ADMIN):** `FX_GAIN_REALIZED` y `FX_LOSS_REALIZED` (`PATCH /chart-of-accounts/system-keys/:systemKey`). Si un pago genera una diferencia ≠ 0 y falta
el mapeo, responde **409** sin registrar nada (ni pago, ni asignaciones, ni asiento). Sin diferencia no se exigen.

Anular un pago revierte exactamente su asiento (incluida la diferencia de cambio) y restaura el saldo. Idempotencia (`idempotencyKey`) y bloqueos transaccionales sin cambio.

### Cuentas por pagar y reportes (`/accounts-payable*`)
- **Fila / detalle:** `currencyCode`, `originalAmount`, `paidAmount`, `balanceDue` en la **moneda del documento**; nuevos `baseCurrencyCode`, `exchangeRate`, `exchangeRateDate`,
  `baseOriginalAmount`, `basePaidAmount` (valor en libros cancelado) y `baseBalanceDue` (saldo en libros). El historial de pagos añade `currencyCode`, `exchangeRate`, `baseCarryingAmount`,
  `baseSettledAmount`, `fxDifferenceAmount`.
- **Resumen / antigüedad / conciliación:** `bySupplier`, `grandTotal`, `totals` y los tramos están **en la moneda de la empresa** (valor en libros), por lo que sumar monedas es válido;
  `baseCurrencyCode` lo indica y **`byCurrency[]`** desglosa la deuda en la moneda original de cada documento (`currencyCode`, `totalPending`, `baseTotalPending`). Nunca se suma USD con PEN directamente.
- **Conciliación** contra el Libro Mayor usa los valores contables (en libros), no la suma de importes originales. Las exportaciones `.xlsx` de cuentas por pagar añaden columnas de moneda de la empresa, tipo de cambio e importe/saldo en libros.

### Históricos
Toda factura y pago anterior se migra con `currencyCode` = moneda de la empresa, tasa `1`, fecha de tasa = fecha contable/de pago e importes originales = contables: sus importes **no cambian**.

---

## 6. Permisos (sin otras ampliaciones)
PURCHASING mantiene todo lo de R3 y **solo** añade registrar países. Incoterm, multimoneda e importación↔compra no cambian permisos. Los demás roles sin ampliaciones.

## 7. Qué debe cambiar el frontend
1. **Errores:** leer `kind`/`errors[]`; pintar errores por campo con `field` (`lines[0].quantity`) y mostrar `kind: "GENERAL"` como aviso. `message` no cambia de tipo.
2. **Países:** reemplazar listas locales por `GET /countries` (activos); permitir a PURCHASING `POST /countries`.
3. **Importaciones:** crear operación con `purchaseInvoiceId` (permitiendo crear antes la factura DRAFT); no enviar `reference`; mostrar proveedor y `invoiceLines`; en embarques, elegir líneas de la factura (solo con la factura `CONFIRMED`); formulario de Incoterm (lugar obligatorio si hay código; `FAS/FOB/CFR/CIF` solo con `SEA`).
4. **Compras:** campos de moneda/tasa/fecha de tasa; distinguir importes de documento y `base*`; `unitCost` con 6 decimales en moneda extranjera.
5. **Pagos:** moneda y tasa del pago; solo facturas de esa moneda; mostrar valor en libros, pagado y diferencia de cambio.
6. **Cuentas por pagar:** mostrar saldo por moneda y equivalente; los totales generales son en moneda de la empresa.

## 8. Cambios incompatibles
| Cambio | Antes | Ahora |
|---|---|---|
| `POST /import-operations` | `reference` obligatorio | `reference` prohibido (400); `purchaseInvoiceId` obligatorio |
| Embarques de operaciones nuevas | líneas sin factura | cada línea referencia una línea de la factura `CONFIRMED` de la operación |
| Anular factura | solo guardias de recepción/pago | además importaciones activas y embarques activos |
| `unitCost` de línea en moneda extranjera | n/a | 6 decimales; en moneda de la empresa se conserva el formato de 2 decimales |
| Totales de CxP (resumen, antigüedad, conciliación) | suma de la moneda única | siempre moneda de la empresa + `byCurrency` |
| `suppliers.countryCode`, países de operaciones | cualquier par de letras | debe existir y estar activo en el catálogo |

## 9. Limitaciones que permanecen
Sin revaluación periódica de saldos extranjeros no pagados, pagos cruzados entre monedas, tasas externas automáticas ni catálogo de tasas; sin cambio de moneda de la empresa con historia;
sin contabilidad de importaciones (gastos de importación siguen sin capitalizar ni asentar) ni declaraciones tributarias.

## 10. Escenarios de aceptación
Cubiertos por `test/r4-business-enhancements.e2e-spec.ts` (33 pruebas): errores por campo (obligatorio, formato, anidado, negocio, general, otros módulos), países (creación entre sesiones, duplicados,
concurrencia, desactivación sin afectar históricos), importación↔compra (DRAFT/CONFIRMED, productos/líneas, sobreasignación concurrente, correlativo sin huecos y reinicio anual, anulación de factura con y sin
importación, carrera anular-vs-embarcar, históricas, sin efectos contables), Incoterm (matriz modo × código, edición por estado, revalidación, CHECK de base) y multimoneda (tasa 1, USD con empresa PEN, empresa en EUR, congelamiento,
redondeo, recepción y valorización convertidas, pago a tasa igual / con pérdida / con ganancia, parciales con distintas tasas, varias facturas, política A, sobrepago, idempotencia, concurrencia, reversas exactas, conciliación y exportaciones).

## 11. Migraciones (para una futura activación controlada)
| # | Migración | Contenido |
|---|---|---|
| 36 | `20261124000000_add_fx_difference_system_keys` | `ADD VALUE` de `FX_GAIN_REALIZED`/`FX_LOSS_REALIZED` (separada por la restricción de PostgreSQL con `ALTER TYPE ... ADD VALUE`). |
| 37 | `20261124000100_add_countries_and_incoterm` | Tabla `countries` + semilla CN/PE/IN + códigos históricos (`pending_review`) + FK; enum y columnas de Incoterm con CHECK. |
| 38 | `20261124000200_link_import_operations_to_purchase_invoices` | `purchase_invoice_id`, `is_legacy_unlinked` (true en lo existente), CHECK y tabla de correlativo anual. |
| 39 | `20261124000300_add_purchase_multicurrency` | Columnas de moneda/tasa/originales en facturas, líneas, pagos y asignaciones, con backfill (tasa 1, originales = contables) y CHECK. |

Todas aditivas; ninguna reescribe importes ni referencias. **Orden:** primero 34 y 35 (R2) si la base aún no las tiene. **Procedimiento recomendado antes de aplicarlas a bases existentes:** respaldo `pg_dump`,
ensayo sobre un **clon aislado**, `prisma migrate deploy` en una ventana controlada y verificación posterior (sin deriva; sumas de importes antes/después; conteo de países; facturas con tasa 1).
Rollback: restaurar el respaldo (las migraciones no incluyen reversa; el cambio es aditivo, por lo que un backend anterior seguiría funcionando contra el esquema nuevo salvo las FK de países).

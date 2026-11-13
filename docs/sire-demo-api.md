# SIRE DEMO — contrato REST para el frontend (Angular)

> **Solo demostración.** No se comunica con SUNAT, no genera tickets, constancias ni códigos CAR, y el formato
> `DEMO_V1` **no** es un layout oficial. Los comprobantes electrónicos del POS provienen del proveedor MOCK y no
> tienen validez fiscal. Cada respuesta JSON incluye `mode: "DEMO"`, `officialValidity: false` y
> `formatVersion: "DEMO_V1"`.

Base: `/api/v1/sire-demo`. Autenticación: cookie HttpOnly de sesión (igual que el resto de la API).
Los importes viajan siempre como **string con 2 decimales** (`"1000.00"`); nunca como número. Solo se suma PEN;
no existe conversión de moneda.

## Disponibilidad del módulo

- Con `SIRE_DEMO_ENABLED=false` (valor por defecto) **ninguna ruta existe**: todas responden **404**, incluso a ADMIN.
  Un `404` en `GET /context` significa "módulo no disponible en este ambiente"; el frontend debe ocultar la sección.
- `source=DEMO_FIXTURES` requiere además `SIRE_DEMO_FIXTURES_ENABLED=true`; si no, responde **403** con
  `code: "SIRE_SOURCE_DISABLED"`.

## Roles

| Operación | ADMIN | ACCOUNTANT | MANAGEMENT | SELLER / WAREHOUSE |
|---|---|---|---|---|
| Lectura, conciliación, Excel | sí | sí | sí | 403 |
| Cargar / descartar propuesta | sí | sí | 403 | 403 |

## Errores

Contrato global: `{ statusCode, error, message, code?, ... }`. `message` puede ser `string` o `string[]`
(`SIRE_FILE_INVALID` lista un error por línea). Códigos estables:

| HTTP | code | Cuándo |
|---|---|---|
| 400 | `SIRE_FILE_REQUIRED` / `SIRE_FILE_EXTENSION_INVALID` / `SIRE_FILE_INVALID` | Archivo ausente, no `.txt`, o inválido (cabecera, filas, límites) |
| 400 | `FIXTURE_VERSION_UNKNOWN` / `FIXTURE_PERIOD_UNAVAILABLE` | Fixtures: versión inexistente o periodo fuera del conjunto |
| 403 | `SIRE_SOURCE_DISABLED` | Origen DEMO_FIXTURES deshabilitado |
| 404 | `SIRE_PROPOSAL_NOT_FOUND` | Propuesta inexistente |
| 409 | `SIRE_PROPOSAL_LIMIT_REACHED` | Ya hay 10 propuestas activas para origen+registro+periodo |
| 409 | `SIRE_PROPOSAL_ALREADY_DISCARDED` / `SIRE_PROPOSAL_DISCARDED` | Descartar de nuevo / conciliar una descartada |
| 409 | `FIXTURE_SET_UNAVAILABLE` | La versión de fixtures guardada ya no existe |
| 409 | `POS_SOURCE_EMPTY` | `sample-file` POS sin documentos representables |
| 413 | — | Archivo de más de 2 MB |

## Rutas (8)

### 1. `GET /context`
Límites (`maxFileBytes: 2097152`, `maxRows: 5000`) y, por origen (`POS`, `DEMO_FIXTURES`): `available`,
`fixtureSetVersion`, `isEmpty` y los periodos con documentos por registro (`RVIE`/`RCE`).

### 2. `GET /registers/:register/documents`
`:register` = `rvie` | `rce` (minúsculas). Query: `source` (obligatorio, `POS`|`DEMO_FIXTURES`), `period`
(obligatorio, `YYYYMM`), `flag?`, `page?`, `pageSize?` (máx. 200).
Respuesta: `summary` (conjunto completo: `documentCount`, `excluded`, `totalsByCurrency`, `flags`), `items[]`
normalizados y paginación `page` / `pageSize` / `totalItems` al nivel superior.

### 3. `GET /registers/:register/sample-file`
Query `source`, `period`. Devuelve un `.txt` DEMO_V1 (`Content-Disposition: attachment`, `X-Sire-Mode: DEMO`).

### 4. `POST /proposals` (multipart/form-data)
Campos: `file` (`.txt`, ≤ 2 MB, ≤ 5000 filas), `source`, `register` (`RVIE`|`RCE`, mayúsculas), `period`.
La cabecera del archivo debe coincidir con los tres campos. Validación completa antes de guardar (todo o nada).

- **201** propuesta nueva · **200** mismo archivo ya activo (`reused: true`, sin duplicar nada).
- Respuesta: `{ mode, officialValidity, formatVersion, reused, proposal }`.

```jsonc
// proposal
{ "id": "uuid", "source": "DEMO_FIXTURES", "register": "RVIE", "period": "202601",
  "fixtureSetVersion": "demo-fixtures-v1", "fileName": "x.txt", "fileSizeBytes": 1234,
  "fileHash": "sha256-hex", "rowCount": 14, "status": "IMPORTED",
  "reconcilable": true, "createdAt": "ISO", "createdBy": { "id": "uuid", "username": "…" },
  "discardedAt": null, "discardedBy": null }
```

### 5. `GET /proposals`
Query opcional: `source`, `register`, `period`, `status` (`IMPORTED`|`DISCARDED`), `page`, `pageSize`.
Respuesta: `{ …envelope, items: proposal[], page, pageSize, totalItems }`. Sin `source`, las propuestas
DEMO_FIXTURES no se listan si ese origen está deshabilitado.

### 6. `POST /proposals/:id/discard`
Descarte lógico (se conservan las líneas). **200** con `{ …envelope, reused: false, proposal }` (`status: DISCARDED`).

### 7. `GET /proposals/:id/reconciliation`
Query: `classification?` (una de las 8 clases), `page?`, `pageSize?` (máx. 200, por defecto 50).

```jsonc
{
  "mode": "DEMO", "officialValidity": false, "formatVersion": "DEMO_V1",
  "source": "DEMO_FIXTURES", "fixtureSetVersion": "demo-fixtures-v1", "register": "RVIE", "period": "202601",
  "proposal": { "id", "source", "register", "period", "fixtureSetVersion", "fileName", "fileHash", "rowCount" },
  "periodRule": "…PROVISIONAL (DEMO)", "sourceNote": "…",
  "excluded": { "notEligibleStatus": 0, "salesWithoutFiscalDocument": null },
  "counts": { "posDocuments": 0, "proposalRows": 0, "items": 0 },
  "summary": {                         // SIEMPRE del conjunto completo (ignora filtro y página)
    "currencyCode": "PEN", "foreignCurrencyDocuments": [], "total": 0,
    "byClassification": { "MATCHED": { "count": 0, "posTotal": "0.00", "proposalTotal": "0.00" } /* …8 clases */ },
    "totals": { "pos": "", "proposalDistinct": "", "duplicateSurplus": "", "proposalRaw": "", "delta": "" }
  },
  "resultDigest": "sha256-hex",        // determinista; coincide con el del Excel
  "classification": null,
  "items": [ {
    "classification": "AMOUNT_MISMATCH",
    "key": { "docTypeCode": "01", "series": "F001", "number": "9", "supplierDocNumber": "…solo RCE" },
    "differences": [ { "field": "total", "pos": "1000.00", "proposal": "1100.00", "delta": "100.00" } ],
    "pos": { "refId", "issueDate", "currencyCode", "counterparty", "taxableBase", "igv", "total", "flags", "internalStatus" },
    "proposal": { "lineNumbers": [9], "occurrences": 1, "issueDate", "counterparty", "taxableBase", "igv", "total", "duplicateSurplusTotal": "0.00" }
  } ],
  "page": 1, "pageSize": 50, "totalItems": 15   // totalItems = ítems que cumplen el filtro
}
```

Clasificaciones: `MATCHED`, `MISSING_IN_POS`, `MISSING_IN_PROPOSAL`, `AMOUNT_MISMATCH`, `PARTY_MISMATCH`,
`DATE_MISMATCH`, `DUPLICATE_IN_PROPOSAL`, `INSUFFICIENT_DATA`. Un duplicado en la propuesta suma **una vez** en
`proposalDistinct`; el excedente va en `duplicateSurplus` (`proposalRaw = proposalDistinct + duplicateSurplus`,
`delta = proposalDistinct − pos`).

### 8. `GET /proposals/:id/reconciliation/export.xlsx`
Query: `classification?`. Exporta **todas** las filas (con el filtro, si se indica), una por ítem, del mismo
cálculo que la ruta 7. Cada fila lleva `Modo = "DEMO — SIN VALIDEZ ANTE SUNAT"`, registro, periodo, origen, versión
de fixtures y `resultDigest`. Si el filtro no tiene resultados, el archivo trae **una fila** con
`Clasificación = "SIN RESULTADOS"` (para conservar la identificación DEMO). Descarga como `sire-demo-<rvie|rce>-<YYYYMM>-<fecha>.xlsx`.

## Flujo sugerido para la pantalla

1. `GET /context` (404 ⇒ ocultar el módulo) → elegir `source` / `register` / `period`.
2. `GET /registers/:r/documents` para previsualizar; `GET /registers/:r/sample-file` para descargar un ejemplo.
3. `POST /proposals` con el archivo → mostrar `reused`.
4. `GET /proposals/:id/reconciliation` (resumen + tabla paginada con filtro por clasificación) y `…/export.xlsx`.
5. `POST /proposals/:id/discard` para retirar una propuesta.

/**
 * NR-06: tope máximo de filas de datos (sin contar el encabezado) por
 * exportación .xlsx, igual para los 4 módulos. Decisión de negocio
 * aprobada explícitamente — nunca truncar en silencio: superarlo responde
 * 400 ANTES de construir ningún workbook, pidiendo acotar los filtros.
 */
export const MAX_EXPORT_ROWS = 20000;

/**
 * Tamaño de página interno usado para recorrer en lotes el método
 * `list()`/`listProducts()` YA EXISTENTE de cada servicio (reutilizado
 * sin duplicar su construcción de `where`/alcance/orden): el mismo límite
 * máximo de paginación que cada controller ya acepta en una consulta
 * normal, nunca uno nuevo.
 */
export const EXPORT_PAGE_SIZE = 100;

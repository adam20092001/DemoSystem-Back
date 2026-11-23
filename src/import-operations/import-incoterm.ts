import { ImportIncoterm, ImportTransportMode } from '@prisma/client';
import { FieldBadRequestException } from '../common/errors/error-contract';

/**
 * Incoterms® 2020 de un embarque (R4). Solo describe el acuerdo comercial:
 * nunca genera gastos, stock, valorización ni asientos.
 */
export const DEFAULT_INCOTERM_VERSION = '2020';
export const SUPPORTED_INCOTERM_VERSIONS: readonly string[] = ['2020'];

/** FAS, FOB, CFR y CIF solo son compatibles con transporte marítimo. */
export const MARITIME_ONLY_INCOTERMS: ReadonlySet<ImportIncoterm> = new Set([
  ImportIncoterm.FAS,
  ImportIncoterm.FOB,
  ImportIncoterm.CFR,
  ImportIncoterm.CIF,
]);

export const INCOTERM_NAMED_PLACE_MAX_LENGTH = 150;

export interface IncotermState {
  incoterm: ImportIncoterm | null;
  incotermNamedPlace: string | null;
  incotermVersion: string | null;
}

export interface IncotermPatch {
  incoterm?: ImportIncoterm | null;
  incotermNamedPlace?: string | null;
  incotermVersion?: string | null;
}

export const EMPTY_INCOTERM_STATE: IncotermState = {
  incoterm: null,
  incotermNamedPlace: null,
  incotermVersion: null,
};

function normalizePlace(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > INCOTERM_NAMED_PLACE_MAX_LENGTH) {
    throw new FieldBadRequestException({
      message: `incotermNamedPlace no puede superar los ${INCOTERM_NAMED_PLACE_MAX_LENGTH} caracteres`,
      code: 'INCOTERM_NAMED_PLACE_TOO_LONG',
      field: 'incotermNamedPlace',
      type: 'FORMAT',
    });
  }
  return trimmed;
}

/**
 * Combina el estado actual con un parche parcial y valida las reglas del
 * Incoterm contra el modo de transporte RESULTANTE:
 *  - sin Incoterm no hay lugar ni versión (nunca se asignan automáticamente);
 *  - con Incoterm el lugar o puerto convenido es obligatorio;
 *  - sin versión se asigna 2020;
 *  - FAS/FOB/CFR/CIF exigen transporte SEA (se revalida si cambia el modo).
 * Retorna el estado resultante a persistir.
 */
export function resolveIncotermState(
  current: IncotermState,
  patch: IncotermPatch,
  transportMode: ImportTransportMode,
  context: { transportModeChanged: boolean },
): IncotermState {
  const nextIncoterm =
    patch.incoterm !== undefined ? patch.incoterm : current.incoterm;

  if (nextIncoterm === null) {
    if (normalizePlace(patch.incotermNamedPlace) !== null) {
      throw new FieldBadRequestException({
        message: 'No se puede informar un lugar convenido sin un incoterm',
        code: 'INCOTERM_REQUIRED_FOR_NAMED_PLACE',
        field: 'incoterm',
      });
    }
    if (patch.incotermVersion !== undefined && patch.incotermVersion !== null) {
      throw new FieldBadRequestException({
        message: 'No se puede informar la versión sin un incoterm',
        code: 'INCOTERM_REQUIRED_FOR_VERSION',
        field: 'incoterm',
      });
    }
    return EMPTY_INCOTERM_STATE;
  }

  const place =
    patch.incotermNamedPlace !== undefined
      ? normalizePlace(patch.incotermNamedPlace)
      : normalizePlace(current.incotermNamedPlace);
  if (place === null) {
    throw new FieldBadRequestException({
      message: 'Con un incoterm es obligatorio indicar el lugar o puerto convenido',
      code: 'INCOTERM_NAMED_PLACE_REQUIRED',
      field: 'incotermNamedPlace',
      type: 'REQUIRED',
    });
  }

  const version =
    patch.incotermVersion ?? current.incotermVersion ?? DEFAULT_INCOTERM_VERSION;
  if (!SUPPORTED_INCOTERM_VERSIONS.includes(version)) {
    throw new FieldBadRequestException({
      message: `incotermVersion no soportada: solo ${SUPPORTED_INCOTERM_VERSIONS.join(', ')}`,
      code: 'INCOTERM_VERSION_UNSUPPORTED',
      field: 'incotermVersion',
      type: 'FORMAT',
    });
  }

  if (
    MARITIME_ONLY_INCOTERMS.has(nextIncoterm) &&
    transportMode !== ImportTransportMode.SEA
  ) {
    const blamesMode = context.transportModeChanged && patch.incoterm === undefined;
    throw new FieldBadRequestException({
      message: `El incoterm ${nextIncoterm} solo es compatible con transporte marítimo (SEA)`,
      code: 'INCOTERM_REQUIRES_SEA_TRANSPORT',
      field: blamesMode ? 'transportMode' : 'incoterm',
    });
  }

  return {
    incoterm: nextIncoterm,
    incotermNamedPlace: place,
    incotermVersion: version,
  };
}

import { DEMO_FIXTURES_V1 } from './demo-fixtures-v1';
import { FixtureSet } from './fixture-set';

/**
 * Registro de conjuntos de fixtures soportados. Un conjunto, una vez
 * publicado, es inmutable: contenido nuevo = versión nueva. Quitar una
 * versión del registro es una decisión deliberada: toda propuesta importada
 * con esa versión dejará de poder conciliarse (409 en S3), nunca se
 * recalcula contra otra versión.
 */
const FIXTURE_SETS: readonly FixtureSet[] = [DEMO_FIXTURES_V1];

/** Versión vigente: la que sirven el contexto, la previsualización y el archivo de ejemplo. */
export const CURRENT_FIXTURE_SET: FixtureSet = DEMO_FIXTURES_V1;

export function getFixtureSet(version: string): FixtureSet | undefined {
  return FIXTURE_SETS.find((set) => set.version === version);
}

export function supportedFixtureVersions(): string[] {
  return FIXTURE_SETS.map((set) => set.version);
}

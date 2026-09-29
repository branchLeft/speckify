import type { Bump } from '../version/index.js';

export type SurfaceLanguage = 'typescript' | 'python';

/** One difference between the previous and current generated public surface. */
export interface SurfaceChange {
  readonly language: SurfaceLanguage;
  /** Where the change is, e.g. `./types#CreateThingData` or `pkg.client.models.Pet`. */
  readonly symbol: string;
  readonly bump: 'minor' | 'major';
  readonly reason: string;
}

export interface SurfaceReport {
  /** The highest change's bump; `none` when both surfaces are identical. */
  readonly bump: Bump;
  readonly changes: readonly SurfaceChange[];
}

/** Which way a type flows between the consumer and the SDK; see surface.md §3. */
export type Role = 'input' | 'output';

/** The report for a list of changes: the highest bump, `none` when there are none. */
export function reportOf(changes: readonly SurfaceChange[]): SurfaceReport {
  const bump: Bump = changes.some((change) => change.bump === 'major')
    ? 'major'
    : changes.length > 0
      ? 'minor'
      : 'none';
  return { bump, changes };
}

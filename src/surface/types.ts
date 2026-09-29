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
  /** The highest **client**-surface change's bump; `none` when both client surfaces are identical. */
  readonly bump: Bump;
  /** Changes to the client surface (TS client/types/zod entry points; Python client + models). */
  readonly changes: readonly SurfaceChange[];
  /**
   * Changes to the server-only surface (TS `./server`; Python `<pkg>.server`).
   * Reported for visibility — a producer regenerating their own server needs
   * to know — but never fed into the bump: only the producer who made the
   * change consumes the server package, per surface.md §1.
   */
  readonly serverChanges: readonly SurfaceChange[];
}

/** Which way a type flows between the consumer and the SDK; see surface.md §3. */
export type Role = 'input' | 'output';

/**
 * The report for a list of client-surface changes: the highest bump, `none`
 * when there are none. `serverChanges` rides along unjudged (see
 * {@link SurfaceReport.serverChanges}).
 */
export function reportOf(
  changes: readonly SurfaceChange[],
  serverChanges: readonly SurfaceChange[] = [],
): SurfaceReport {
  const bump: Bump = changes.some((change) => change.bump === 'major')
    ? 'major'
    : changes.length > 0
      ? 'minor'
      : 'none';
  return { bump, changes, serverChanges };
}

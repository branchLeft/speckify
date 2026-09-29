import { inc, valid } from 'semver';

import { VersionError } from './errors.js';
import type { Bump } from './types.js';

/**
 * A brand-new contract always starts at 1.0.0, never 0.x. A 0.x series
 * reads to consumers as "not a stable contract yet", which is never true
 * here: the bump machinery is exactly what makes every published version
 * stable from the first one.
 */
export const FIRST_PUBLISHED_VERSION = '1.0.0';

const BUMP_RANK: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

/** The highest-severity bump among `bumps`, or `none` if the list is empty. */
export function maxBump(bumps: readonly Bump[]): Bump {
  let result: Bump = 'none';
  for (const bump of bumps) {
    if (BUMP_RANK[bump] > BUMP_RANK[result]) {
      result = bump;
    }
  }
  return result;
}

/**
 * Applies `bump` to `currentVersion`. `currentVersion` of `null` means the
 * contract has never been published, which always resolves to
 * {@link FIRST_PUBLISHED_VERSION} regardless of `bump`.
 *
 * @throws {VersionError} if `currentVersion` is not valid semver.
 */
export function applyBump(bump: Bump, currentVersion: string | null): string {
  if (currentVersion === null) {
    return FIRST_PUBLISHED_VERSION;
  }
  if (valid(currentVersion) === null) {
    throw new VersionError(`"${currentVersion}" is not a valid semver version`);
  }
  if (bump === 'none') {
    return currentVersion;
  }

  const next = inc(currentVersion, bump);
  if (next === null) {
    throw new VersionError(`could not apply a ${bump} bump to "${currentVersion}"`);
  }
  return next;
}

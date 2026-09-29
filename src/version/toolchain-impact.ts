import { gt, lte } from 'semver';

import { maxBump } from './bump.js';
import { VersionError } from './errors.js';
import { readJsonFile } from './json-file.js';
import { toolchainImpactFileSchema, type ToolchainImpactEntry } from './types.js';
import type { Bump } from './types.js';

/**
 * `toolchain-impact.json`'s file name inside `data/`. Like the classification
 * map, this is Speckify's own artifact — shipped with the package, not
 * something a consuming repo provides alongside its speckify.yaml — so it
 * resolves relative to the package root, not the caller's config directory.
 */
export const TOOLCHAIN_IMPACT_FILENAME = 'toolchain-impact.json';

/**
 * The bump every consumer inherits purely from moving Speckify's own
 * toolchain forward, independent of any change to their spec: a generator
 * fix that changes emitted code shape is a break even when the spec it
 * generates from did not move.
 *
 * `previous` of `null` means the contract has never been published before at
 * all, in which case there is no prior toolchain state to have drifted from,
 * so the impact is `none`.
 *
 * `previous.speckifyVersion` of `null` is a *different* case: the contract
 * has been published, but the version that generated it could not be read
 * back (an old package predating the embedded version field, or a
 * corrupted/incomplete one). That generating version is unknown, not
 * absent -- so it fails safe as though it predates every recorded release,
 * taking the max impact across the whole table up to `currentSpeckifyVersion`,
 * rather than silently reading back as `none`.
 */
export function toolchainImpact(
  entries: readonly ToolchainImpactEntry[],
  previous: { speckifyVersion: string | null } | null,
  currentSpeckifyVersion: string,
): Bump {
  if (previous === null) {
    return 'none';
  }

  const previousSpeckifyVersion = previous.speckifyVersion;
  const relevant = entries.filter((entry) => {
    const afterPrevious =
      previousSpeckifyVersion === null || gt(entry.speckifyVersion, previousSpeckifyVersion);
    return afterPrevious && lte(entry.speckifyVersion, currentSpeckifyVersion);
  });

  return maxBump(relevant.map((entry) => entry.impact));
}

/**
 * Loads and validates the committed `toolchain-impact.json`: the list of
 * Speckify releases and the bump each one declares for its consumers.
 *
 * @throws {VersionError} if the file cannot be read or parsed as JSON, or
 * fails schema validation.
 */
export async function loadToolchainImpact(filePath: string): Promise<ToolchainImpactEntry[]> {
  const raw = await readJsonFile(filePath);
  const result = toolchainImpactFileSchema.safeParse(raw);
  if (!result.success) {
    throw new VersionError(
      `${filePath} is not a valid toolchain-impact file: ${result.error.message}`,
    );
  }
  return result.data;
}

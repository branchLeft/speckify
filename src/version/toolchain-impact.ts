import { gt, lte } from 'semver';

import { maxBump } from './bump.js';
import { VersionError } from './errors.js';
import { readJsonFile } from './json-file.js';
import { toolchainImpactFileSchema, type ToolchainImpactEntry } from './types.js';
import type { Bump } from './types.js';

/**
 * The bump every consumer inherits purely from moving Speckify's own
 * toolchain forward, independent of any change to their spec: a generator
 * fix that changes emitted code shape is a break even when the spec it
 * generates from did not move.
 *
 * `previousSpeckifyVersion` of `null` means the contract has never been
 * generated before, in which case there is no prior toolchain state to have
 * drifted from, so the impact is `none`.
 */
export function toolchainImpact(
  entries: readonly ToolchainImpactEntry[],
  previousSpeckifyVersion: string | null,
  currentSpeckifyVersion: string,
): Bump {
  if (previousSpeckifyVersion === null) {
    return 'none';
  }

  const relevant = entries.filter(
    (entry) =>
      gt(entry.speckifyVersion, previousSpeckifyVersion) &&
      lte(entry.speckifyVersion, currentSpeckifyVersion),
  );

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

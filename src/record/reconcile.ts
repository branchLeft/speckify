import { compare, valid } from 'semver';

import type { RegistryRecordEntry } from './types.js';

/** One contract target's published state, keyed by a name such as `typescript-client`. */
export interface TargetRecord {
  target: string;
  entry: RegistryRecordEntry | null;
}

export interface ReconcileResult {
  /** The highest version any target has published, or `null` if none has. */
  maxVersion: string | null;
  /** Targets that have not yet published `maxVersion` (never published, or lagging behind it). */
  missingTargets: string[];
}

/**
 * A contract publishes to several targets (an npm package, a PyPI package, …)
 * that can drift out of step with each other. The registry's record of truth
 * for the contract as a whole is the highest version any target reports;
 * this reports which targets have not caught up to it, so a caller can
 * republish them.
 */
export function reconcileVersions(records: readonly TargetRecord[]): ReconcileResult {
  let maxVersion: string | null = null;

  for (const record of records) {
    const version = record.entry?.version;
    if (version === undefined || !valid(version)) {
      continue;
    }
    if (maxVersion === null || compare(version, maxVersion) > 0) {
      maxVersion = version;
    }
  }

  if (maxVersion === null) {
    return { maxVersion: null, missingTargets: records.map((record) => record.target) };
  }

  const missingTargets = records
    .filter((record) => record.entry?.version !== maxVersion)
    .map((record) => record.target);

  return { maxVersion, missingTargets };
}

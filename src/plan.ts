import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toCanonicalJson } from './bundle/canonical-json.js';
import { lintBundledSpec } from './lint/index.js';
import { runOasdiffChangelog, type OasdiffChange, type ProcessRunner } from './oasdiff/index.js';
import type { RegistryRecordEntry } from './record/index.js';
import {
  applyBump,
  classify,
  maxBump,
  type Bump,
  type ClassificationMap,
} from './version/index.js';

export interface ContractPlanInput {
  /** The contract's name, as declared in speckify.yaml. */
  contract: string;
  /** This contract's freshly bundled spec, with the 0.0.0 placeholder version. */
  bundledSpec: string;
  /** The last published state for this contract across its targets, or null if never published. */
  previous: RegistryRecordEntry | null;
  classificationMap: ClassificationMap;
  /** The bump every consumer inherits from Speckify's own toolchain moving forward. */
  toolchainImpactBump: Bump;
  oasdiffPath: string;
  runProcess?: ProcessRunner | undefined;
}

export interface ContractPlan {
  contract: string;
  previousVersion: string | null;
  version: string;
  bump: Bump;
  unknownRuleIds: string[];
  changes: OasdiffChange[];
  /** The bundled spec with `version` stamped into its `info.version`. */
  bundledSpec: string;
}

function stampVersion(bundledSpecJson: string, version: string): string {
  const doc = JSON.parse(bundledSpecJson) as { info: { version: string } };
  doc.info.version = version;
  return toCanonicalJson(doc);
}

/** The placeholder every fresh bundle stamps into `info.version`; see `bundle/index.ts`. */
const PLACEHOLDER_VERSION = '0.0.0';

/**
 * Keys that never carry semantic meaning for a client: prose annotations
 * oasdiff (correctly) does not diff on. Stripped from both sides before
 * the doc-only-difference fallback check in {@link computeContractPlan},
 * never before the real oasdiff diff itself.
 */
const DOC_ONLY_KEYS = new Set([
  'description',
  'summary',
  'example',
  'examples',
  'externalDocs',
  'title',
]);

function stripDocOnlyKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripDocOnlyKeys);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (DOC_ONLY_KEYS.has(key)) {
        continue;
      }
      result[key] = stripDocOnlyKeys(val);
    }
    return result;
  }
  return value;
}

function withPlaceholderVersion(doc: Record<string, unknown>): Record<string, unknown> {
  const info = doc.info;
  if (info === null || typeof info !== 'object') {
    return doc;
  }
  return { ...doc, info: { ...(info as Record<string, unknown>), version: PLACEHOLDER_VERSION } };
}

/**
 * Normalises a bundled spec's `info.version` to the shared placeholder, so
 * the real oasdiff diff (and the raw-text-equality check that gates the
 * fallback below) never sees a difference that is purely "this is the spec
 * we last published at version X" vs "this is a fresh bundle, unstamped".
 */
function normalizeInfoVersionForComparison(bundledSpecJson: string): string {
  const doc = JSON.parse(bundledSpecJson) as Record<string, unknown>;
  return toCanonicalJson(withPlaceholderVersion(doc));
}

/**
 * True only when two specs are identical once `info.version` is normalised
 * and doc-only annotations are stripped from both. This is the fail-safe
 * fallback for "oasdiff reported no changes, but the spec text differs":
 * oasdiff missing a real, client-visible change must never read as "no
 * changes" (a republish of an unchanged spec, or an under-bump) — so
 * anything beyond a doc-only/version difference bumps MAJOR instead of the
 * PATCH this path used to apply unconditionally.
 */
function isDocOnlyDifference(previousSpecJson: string, currentSpecJson: string): boolean {
  const previous = withPlaceholderVersion(JSON.parse(previousSpecJson) as Record<string, unknown>);
  const current = withPlaceholderVersion(JSON.parse(currentSpecJson) as Record<string, unknown>);
  return toCanonicalJson(stripDocOnlyKeys(previous)) === toCanonicalJson(stripDocOnlyKeys(current));
}

/**
 * Computes one contract's plan: lint, diff against the last published spec,
 * bump, and the resulting version. See `plan.md` for the first-publish and
 * lint-ordering behaviour this depends on.
 *
 * @throws {LintError} if the bundled spec fails lint.
 */
export async function computeContractPlan(input: ContractPlanInput): Promise<ContractPlan> {
  lintBundledSpec(input.bundledSpec);

  const previousVersion = input.previous?.version ?? null;

  let changes: OasdiffChange[] = [];
  let unknownRuleIds: string[] = [];
  let specBump: Bump = 'none';

  if (input.previous !== null) {
    const tempDir = await mkdtemp(join(tmpdir(), 'speckify-plan-'));
    try {
      const basePath = join(tempDir, 'base.json');
      const revisionPath = join(tempDir, 'revision.json');
      // Both sides are diffed with info.version normalised to the same
      // placeholder: otherwise the version bump we are computing would
      // itself show up as a diff (e.g. oasdiff's own api-version-not-bumped
      // check), and a real published spec's stamped version would never
      // equal a fresh bundle's 0.0.0 even when nothing else changed.
      await writeFile(
        basePath,
        normalizeInfoVersionForComparison(input.previous.bundledSpec),
        'utf8',
      );
      await writeFile(revisionPath, normalizeInfoVersionForComparison(input.bundledSpec), 'utf8');

      changes = await runOasdiffChangelog({
        oasdiffPath: input.oasdiffPath,
        baseSpecPath: basePath,
        revisionSpecPath: revisionPath,
        runProcess: input.runProcess,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    const classified = classify(changes, input.classificationMap);
    unknownRuleIds = classified.unknownRuleIds;
    const textDiffersOnceVersionIsNormalized =
      normalizeInfoVersionForComparison(input.previous.bundledSpec) !==
      normalizeInfoVersionForComparison(input.bundledSpec);
    if (changes.length === 0 && textDiffersOnceVersionIsNormalized) {
      // oasdiff saw no semantic diff, but the spec text differs beyond just
      // info.version. Only patch-bump when that difference really is
      // doc-only (e.g. a description); anything else means oasdiff missed a
      // real change, and under-bumping that is worse than over-bumping, so
      // fail safe to MAJOR.
      specBump = isDocOnlyDifference(input.previous.bundledSpec, input.bundledSpec)
        ? 'patch'
        : 'major';
    } else {
      specBump = classified.bump;
    }
  }

  const bump = maxBump([specBump, input.toolchainImpactBump]);
  const version = applyBump(bump, previousVersion);

  return {
    contract: input.contract,
    previousVersion,
    version,
    bump,
    unknownRuleIds,
    changes,
    bundledSpec: stampVersion(input.bundledSpec, version),
  };
}

/** Renders a set of oasdiff changes as a Markdown changelog, newest concerns first by level. */
export function renderChangelogMarkdown(changes: readonly OasdiffChange[]): string {
  if (changes.length === 0) {
    return 'No changes.\n';
  }

  const lines = changes
    .slice()
    .sort((a, b) => b.level - a.level)
    .map((change) => {
      const location = [change.operation, change.path]
        .filter((part) => part !== undefined)
        .join(' ');
      const suffix = location === '' ? '' : ` (${location})`;
      return `- **${change.id}**${suffix}: ${change.text}`;
    });

  return `${lines.join('\n')}\n`;
}

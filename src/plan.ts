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
  diffDocuments,
  findUncoveredEdits,
  maxBump,
  prepareDocument,
  type Bump,
  type ClassificationMap,
  type OasdiffCoverage,
  type UncoveredEdit,
} from './version/index.js';
import { normalizeForComparison } from './version/structural-diff.js';

export interface ContractPlanInput {
  /** The contract's name, as declared in speckify.yaml. */
  contract: string;
  /** This contract's freshly bundled spec, with the 0.0.0 placeholder version. */
  bundledSpec: string;
  /** The last published state for this contract across its targets, or null if never published. */
  previous: RegistryRecordEntry | null;
  classificationMap: ClassificationMap;
  /** Where oasdiff 1.x judges changes at all; see `version/location-coverage.md`. */
  coverage: OasdiffCoverage;
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
  /** Structural edits oasdiff cannot be shown to judge; any one forces major. */
  uncovered: UncoveredEdit[];
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

function withPlaceholderVersion(doc: Record<string, unknown>): Record<string, unknown> {
  const info = doc.info;
  if (info === null || typeof info !== 'object') {
    return doc;
  }
  return { ...doc, info: { ...(info as Record<string, unknown>), version: PLACEHOLDER_VERSION } };
}

/**
 * Normalises a bundled spec's `info.version` to the shared placeholder, so
 * neither oasdiff nor the text-equality check sees the stamped version.
 */
function normalizeInfoVersionForComparison(bundledSpecJson: string): string {
  const doc = JSON.parse(bundledSpecJson) as Record<string, unknown>;
  return toCanonicalJson(withPlaceholderVersion(doc));
}

/** True only when two specs are identical once normalised and annotation-stripped. */
function isDocOnlyDifference(previousSpecJson: string, currentSpecJson: string): boolean {
  const previous = normalizeForComparison(JSON.parse(previousSpecJson) as Record<string, unknown>);
  const current = normalizeForComparison(JSON.parse(currentSpecJson) as Record<string, unknown>);
  return toCanonicalJson(previous) === toCanonicalJson(current);
}

/** Every structural edit oasdiff cannot be shown to judge; see version/location-coverage.md. */
function uncoveredEdits(
  previousSpecJson: string,
  currentSpecJson: string,
  coverage: OasdiffCoverage,
  changes: readonly OasdiffChange[],
): UncoveredEdit[] {
  const edits = diffDocuments(
    prepareDocument(JSON.parse(previousSpecJson) as Record<string, unknown>),
    prepareDocument(JSON.parse(currentSpecJson) as Record<string, unknown>),
  );
  return findUncoveredEdits(edits, coverage, changes);
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
  let uncovered: UncoveredEdit[] = [];
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

    // Unconditional: an unjudged change must not inherit whatever bump
    // oasdiff gave the changes it did judge (location-coverage.md §6).
    uncovered = uncoveredEdits(
      input.previous.bundledSpec,
      input.bundledSpec,
      input.coverage,
      changes,
    );

    if (uncovered.length > 0) {
      specBump = 'major';
    } else if (changes.length === 0 && textDiffersOnceVersionIsNormalized) {
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
    uncovered,
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

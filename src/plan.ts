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
      await writeFile(basePath, input.previous.bundledSpec, 'utf8');
      await writeFile(revisionPath, input.bundledSpec, 'utf8');

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
    specBump =
      changes.length === 0 && input.previous.bundledSpec !== input.bundledSpec
        ? 'patch' // the spec text changed (e.g. a description) but oasdiff saw no semantic diff
        : classified.bump;
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

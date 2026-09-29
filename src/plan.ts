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
  /**
   * Every JSON-Schema/OpenAPI keyword oasdiff's own rule catalogue judges
   * at all (`data/oasdiff-<version>.covered-keywords.json`, loaded via
   * `version/covered-keywords.ts`). A structural change at a keyword absent
   * from this set is one oasdiff has no rule for -- see the structural
   * fallback below.
   */
  coveredKeywords: ReadonlySet<string>;
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
 * the doc-only-difference fallback check and the structural keyword diff
 * in {@link computeContractPlan}, never before the real oasdiff diff
 * itself.
 */
const DOC_ONLY_KEYS = new Set([
  'description',
  'summary',
  'example',
  'examples',
  'externalDocs',
  'title',
]);

/**
 * Keys whose *children* are arbitrary, producer-chosen names -- a property
 * name, a schema name, a path template, a status code, a media type, a
 * security scheme name, a discriminator mapping key -- never a fixed
 * JSON-Schema/OpenAPI keyword. `stripDocOnlyKeys` must not treat a child
 * key here as a doc-only annotation just because it happens to spell
 * "title" or "description" (a property can be legitimately named either);
 * `collectChangedKeywords` must not treat a child key here as "the keyword
 * that changed" (adding or removing a property, a schema, a path, ... is
 * not a keyword-level edit at all, and is exactly what oasdiff's ordinary
 * rules already cover).
 */
const NAME_MAP_KEYS = new Set([
  'paths',
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
  'schemas',
  'responses',
  'content',
  'parameters',
  'securitySchemes',
  'webhooks',
  'callbacks',
  'headers',
  'examples',
  'requestBodies',
  'links',
  'mapping',
  'dependentRequired',
  'dependentSchemas',
  'encoding',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Strips {@link DOC_ONLY_KEYS} only in annotation position: never as a key
 * of a {@link NAME_MAP_KEYS} container, where the key is an arbitrary name
 * chosen by the spec's author (a property called "title", a schema called
 * "Description", ...) rather than the JSON-Schema/OpenAPI `title` or
 * `description` keyword.
 */
function stripDocOnlyKeys(value: unknown, parentIsNameMap = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripDocOnlyKeys(item, false));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (!parentIsNameMap && DOC_ONLY_KEYS.has(key)) {
        continue;
      }
      result[key] = stripDocOnlyKeys(val, NAME_MAP_KEYS.has(key) && isPlainObject(val));
    }
    return result;
  }
  return value;
}

/**
 * Walks two doc-stripped, version-normalised spec trees and collects every
 * JSON-Schema/OpenAPI *keyword* whose value differs between them --
 * `additionalProperties`, `servers`, `minLength`, `type`, and so on.
 *
 * A {@link NAME_MAP_KEYS} container's own children are never reported by
 * name: adding, removing or renaming a property/schema/path/... is not a
 * keyword-level edit, and is exactly what oasdiff's ordinary generated
 * rules already classify. Only a genuine change to a *shared* child's
 * value recurses further (so a property present on both sides can still
 * surface a keyword change inside its own schema); a child present on only
 * one side is a plain addition/removal and is not descended into.
 *
 * An array-valued keyword (`servers`, `required`, `enum`, an operation's
 * `parameters`, ...) is compared as one atomic unit: any element-level
 * difference reports the keyword itself, not a position inside the array.
 */
function collectChangedKeywords(a: unknown, b: unknown, parentIsNameMap = false): Set<string> {
  const changed = new Set<string>();

  if (parentIsNameMap) {
    const aObj = isPlainObject(a) ? a : {};
    const bObj = isPlainObject(b) ? b : {};
    for (const key of new Set([...Object.keys(aObj), ...Object.keys(bObj)])) {
      if (!(key in aObj) || !(key in bObj)) {
        continue; // a pure add/remove under a name map: oasdiff's own business
      }
      for (const keyword of collectChangedKeywords(aObj[key], bObj[key], false)) {
        changed.add(keyword);
      }
    }
    return changed;
  }

  if (!isPlainObject(a) || !isPlainObject(b)) {
    return changed;
  }

  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[key];
    const bv = b[key];
    const bothMapOrMissing =
      (isPlainObject(av) || av === undefined) && (isPlainObject(bv) || bv === undefined);

    if (NAME_MAP_KEYS.has(key) && bothMapOrMissing) {
      for (const keyword of collectChangedKeywords(av, bv, true)) {
        changed.add(keyword);
      }
      continue;
    }
    if (isPlainObject(av) && isPlainObject(bv)) {
      // A structural container this key's own name doesn't classify
      // (an Operation, Schema, Response, RequestBody, MediaType object,
      // ...): recurse to find the actual keyword that differs inside it,
      // rather than reporting the container's own key.
      for (const keyword of collectChangedKeywords(av, bv, false)) {
        changed.add(keyword);
      }
      continue;
    }
    // A scalar, an array (compared as one atomic unit -- see the doc
    // comment above), or the container itself appearing/disappearing
    // wholesale: this key is the keyword that changed.
    if (toCanonicalJson(av) !== toCanonicalJson(bv)) {
      changed.add(key);
    }
  }
  return changed;
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

    // Structural fallback: a real difference at a keyword oasdiff's own
    // rule catalogue never looks at (see coveredKeywords) carries no
    // information from oasdiff's silence about it, no matter what oasdiff
    // *did* report elsewhere -- e.g. a tightened additionalProperties
    // alongside an unrelated, correctly-classified new response property
    // must still force major, not inherit the minor oasdiff gave the part
    // it does understand. Runs on doc-stripped, version-normalised specs,
    // same as the doc-only fallback below.
    const strippedPrevious = stripDocOnlyKeys(
      withPlaceholderVersion(JSON.parse(input.previous.bundledSpec) as Record<string, unknown>),
    );
    const strippedCurrent = stripDocOnlyKeys(
      withPlaceholderVersion(JSON.parse(input.bundledSpec) as Record<string, unknown>),
    );
    const changedKeywords = collectChangedKeywords(strippedPrevious, strippedCurrent);
    const uncoveredKeywords = [...changedKeywords].filter(
      (keyword) => !input.coveredKeywords.has(keyword),
    );

    if (uncoveredKeywords.length > 0) {
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

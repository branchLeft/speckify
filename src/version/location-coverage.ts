import type { z } from 'zod';

import { OASDIFF_VERSION } from '../oasdiff/version.js';
import { VersionError } from './errors.js';
import { readJsonFile } from './json-file.js';
import type { Edit, EditAction } from './structural-diff.js';
import { locationClaimsFileSchema, silentClaimsFileSchema, type SchemaClass } from './types.js';

/** One oasdiff rule location, split into segments, with the actions it reports there. */
export interface LocationClaim {
  readonly pattern: readonly string[];
  readonly actions: ReadonlySet<string>;
}

/** A claim oasdiff declares but does not report on, for the listed schema classes. */
export interface SilentClaim {
  readonly pattern: readonly string[];
  readonly actions: ReadonlySet<string>;
  readonly classes: ReadonlySet<SchemaClass>;
}

export interface OasdiffCoverage {
  readonly claims: readonly LocationClaim[];
  readonly silent: readonly SilentClaim[];
}

export type UncoveredReason =
  | 'no-claim'
  | 'silent-claim'
  | 'new-request-constraint'
  | 'unreported-operation';

export interface UncoveredEdit {
  readonly edit: Edit;
  readonly reason: UncoveredReason;
}

/** The part of an oasdiff change that places it: see `oasdiff/types.ts`. */
export interface ReportedChange {
  readonly path?: string | undefined;
  readonly operation?: string | undefined;
}

/** oasdiff's `MatchLocation`: `*` is one segment, `**` any run (even none). */
export function matchLocation(pattern: readonly string[], location: readonly string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) {
    return location.length === 0;
  }
  if (head === '**') {
    return (
      matchLocation(rest, location) ||
      (location.length > 0 && matchLocation(pattern, location.slice(1)))
    );
  }
  const [first, ...remaining] = location;
  if (first === undefined || (head !== '*' && head !== first)) {
    return false;
  }
  return matchLocation(rest, remaining);
}

function bodySchemaRootLength(location: readonly string[]): number | undefined {
  const isSchema = (segment: string | undefined): boolean =>
    segment === 'schema' || segment === 'itemSchema';
  if (location[0] !== 'paths') return undefined;
  if (location[3] === 'requestBody' && location[4] === 'content' && isSchema(location[6])) {
    return 7;
  }
  if (location[3] === 'responses' && location[5] === 'content' && isSchema(location[7])) {
    return 8;
  }
  return undefined;
}

/** Descents that consume a following name segment, and the class they set. */
const NAMED_DESCENTS: Readonly<Record<string, 'property' | 'subschema' | 'allOf'>> = {
  properties: 'property',
  anyOf: 'subschema',
  allOf: 'allOf',
};
const PLAIN_DESCENTS = new Set(['items', 'additionalProperties']);

/**
 * Collapses nested body-schema descents onto oasdiff's claim location and
 * names the schema class. See location-coverage.md §4.
 */
export function toClaimLocation(concrete: readonly string[]): {
  location: string[];
  schemaClass: SchemaClass;
} {
  const location = concrete.map((segment) => (segment.startsWith('x-') ? 'x-*' : segment));
  const rootLength = bodySchemaRootLength(location);
  if (rootLength === undefined) {
    return { location, schemaClass: 'root' };
  }
  const rest = location.slice(rootLength);
  let kind: 'root' | 'property' | 'subschema' = 'root';
  let allOfAfter = false;
  let index = 0;
  for (;;) {
    const segment = rest[index] ?? '';
    const named = NAMED_DESCENTS[segment];
    if (named !== undefined && index + 2 < rest.length) {
      if (named === 'allOf') allOfAfter = true;
      else [kind, allOfAfter] = [named, false];
      index += 2;
    } else if (PLAIN_DESCENTS.has(segment) && index + 1 < rest.length) {
      [kind, allOfAfter] = ['subschema', false];
      index += 1;
    } else {
      break;
    }
  }
  return {
    location: [...location.slice(0, rootLength), ...rest.slice(index)],
    schemaClass: allOfAfter ? `${kind}+allOf` : kind,
  };
}

const CONSTRAINT_KEYWORDS = new Set([
  'enum',
  'const',
  'maxLength',
  'minLength',
  'maximum',
  'minimum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'multipleOf',
  'pattern',
  'format',
  'maxItems',
  'minItems',
  'uniqueItems',
  'maxProperties',
  'minProperties',
  'maxContains',
  'minContains',
  'required',
  'additionalProperties',
]);

function isRequestSide(location: readonly string[]): boolean {
  return (
    location[0] === 'paths' &&
    (location[2] === 'parameters' || location[3] === 'parameters' || location[3] === 'requestBody')
  );
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === false || (Array.isArray(value) && value.length === 0);
}

/** An edit that introduces a constraint where none existed, inside a request schema (§5). */
function isNewRequestConstraint(edit: Edit): boolean {
  const keyword = edit.location[edit.location.length - 1] ?? '';
  if (!CONSTRAINT_KEYWORDS.has(keyword) || !isRequestSide(edit.location)) {
    return false;
  }
  if (!edit.location.slice(0, -1).includes('schema')) {
    return false;
  }
  if (keyword === 'additionalProperties') {
    return edit.after === false && edit.before !== false;
  }
  return isEmpty(edit.before) && !isEmpty(edit.after);
}

function claimMatches(
  claim: { pattern: readonly string[]; actions: ReadonlySet<string> },
  location: readonly string[],
  action: EditAction,
): boolean {
  return claim.actions.has(action) && matchLocation(claim.pattern, location);
}

function isReported(edit: Edit, reported: readonly ReportedChange[]): boolean {
  const [root, path, second] = edit.location;
  if (root !== 'paths' || path === undefined) {
    return true;
  }
  const method = second !== undefined && second !== 'parameters' ? second : undefined;
  if (method === undefined) {
    return reported.some((change) => change.path === path);
  }
  return reported.some(
    (change) => change.path === path && change.operation?.toLowerCase() === method,
  );
}

/** Every edit whose change oasdiff cannot be shown to judge. See location-coverage.md §4-6. */
export function findUncoveredEdits(
  edits: readonly Edit[],
  coverage: OasdiffCoverage,
  reported: readonly ReportedChange[],
): UncoveredEdit[] {
  const uncovered: UncoveredEdit[] = [];
  for (const edit of edits) {
    const reason = uncoveredReason(edit, coverage, reported);
    if (reason !== undefined) {
      uncovered.push({ edit, reason });
    }
  }
  return uncovered;
}

function uncoveredReason(
  edit: Edit,
  coverage: OasdiffCoverage,
  reported: readonly ReportedChange[],
): UncoveredReason | undefined {
  if (isNewRequestConstraint(edit)) {
    return 'new-request-constraint';
  }
  const { location, schemaClass } = toClaimLocation(edit.location);
  if (!coverage.claims.some((claim) => claimMatches(claim, location, edit.action))) {
    return 'no-claim';
  }
  const silent = coverage.silent.some(
    (entry) => entry.classes.has(schemaClass) && claimMatches(entry, location, edit.action),
  );
  if (silent) {
    return 'silent-claim';
  }
  return isReported(edit, reported) ? undefined : 'unreported-operation';
}

export interface LoadOasdiffCoverageOptions {
  /** Overridden only in tests; defaults to the oasdiff version Speckify is pinned to. */
  expectedOasdiffVersion?: string;
}

async function readPinned<T extends { oasdiffVersion: string }>(
  filePath: string,
  schema: z.ZodType<T>,
  expected: string,
): Promise<T> {
  const result = schema.safeParse(await readJsonFile(filePath));
  if (!result.success) {
    throw new VersionError(`${filePath} is not a valid coverage file: ${result.error.message}`);
  }
  const data = result.data;
  if (data.oasdiffVersion !== expected) {
    throw new VersionError(
      `${filePath} is pinned to oasdiff ${data.oasdiffVersion}, but Speckify is pinned to ${expected}; regenerate it (scripts/generate-oasdiff-location-claims.mjs) and re-run the empirical validation before upgrading oasdiff`,
    );
  }
  return data;
}

/**
 * Loads the generated location claims and the hand-curated silent claims.
 * @throws {VersionError} on an unreadable or invalid file, or a version mismatch.
 */
export async function loadOasdiffCoverage(
  claimsPath: string,
  silentPath: string,
  options: LoadOasdiffCoverageOptions = {},
): Promise<OasdiffCoverage> {
  const expected = options.expectedOasdiffVersion ?? OASDIFF_VERSION;
  const claimsFile = await readPinned(claimsPath, locationClaimsFileSchema, expected);
  const silentFile = await readPinned(silentPath, silentClaimsFileSchema, expected);
  return {
    claims: claimsFile.claims.map((claim) => ({
      pattern: claim.pattern.split('.'),
      actions: new Set(claim.actions),
    })),
    silent: silentFile.entries.map((entry) => ({
      pattern: entry.pattern.split('.'),
      actions: new Set(entry.actions),
      classes: new Set(entry.classes),
    })),
  };
}

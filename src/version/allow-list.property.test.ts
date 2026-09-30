import { describe, expect, it } from 'vitest';

import { allowListBump, isSdkExtension, judgeEdit, judgeEdits } from './allow-list.js';
import {
  CHANGES,
  CHANGES_3_0,
  CHANGES_3_1,
  schemaMatrix,
  type Fixture,
} from './fixtures/schema-matrix.js';
import { diffDocuments, prepareDocument, type Edit, type EditAction } from './structural-diff.js';
import type { Bump } from './types.js';

// The allow-list restated independently, by fixture name and by regex, so a
// rule widened in allow-list.ts without a matching change here fails loudly.

const REQUEST_PLACEMENTS = new Set([
  'requestBody',
  'queryParameter',
  'deepObjectParameter',
  'headerParameter',
  'pathParameter',
  'cookieParameter',
]);
const RESPONSE_PLACEMENTS = new Set(['response', 'responseHeader']);
const NON_PLAIN_NESTINGS = new Set(['anyOf', 'oneOf', 'not']);
const PROPERTY_NESTINGS = new Set([
  'property',
  'propertyOfProperty',
  'itemsProperty',
  'allOfProperty',
]);
const REQUEST_RELAXATION_CHANGES = new Set([
  'maxLengthIncrease',
  'maxLengthUnset',
  'minLengthDecrease',
  'minLengthUnset',
  'enumAdd',
  'patternUnset',
  'minimumDecrease',
  'minimumUnset',
  'maximumIncrease',
  'maximumUnset',
  'maxItemsIncrease',
  'maxItemsUnset',
  'minItemsDecrease',
  'minItemsUnset',
  'requiredRemove',
  'requiredMemberRemoved',
  'additionalPropertiesRemoved',
  'additionalPropertiesTrue',
  'exclusiveMinimumUnset',
  'exclusiveMaximumUnset',
]);
const EXTENSION_CHANGES = new Set(['extensionAdd', 'extensionChange', 'extensionRemove']);

function expectedForFixture(fixture: Fixture): Bump {
  const { change, placement, nesting } = fixture;
  if (EXTENSION_CHANGES.has(change)) return 'patch';
  const request = REQUEST_PLACEMENTS.has(placement);
  const response = RESPONSE_PLACEMENTS.has(placement);
  if ((!request && !response) || NON_PLAIN_NESTINGS.has(nesting)) return 'major';
  if (change === 'propertyAdd') return 'minor';
  if (change === 'deprecatedSet') return PROPERTY_NESTINGS.has(nesting) ? 'minor' : 'major';
  if (request && REQUEST_RELAXATION_CHANGES.has(change)) return 'minor';
  return 'major';
}

function judgeFixture(fixture: Fixture): { bump: Bump; edits: number } {
  const base = prepareDocument(fixture.base);
  const revision = prepareDocument(fixture.revision);
  const edits = diffDocuments(base, revision);
  const judgements = judgeEdits(edits, { base: base.doc, revision: revision.doc });
  return { bump: allowListBump(judgements), edits: edits.length };
}

const RANK: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

describe('the allow-list against every schema change × placement × nesting', () => {
  const fixtures = [
    ...schemaMatrix('3.0.3', { ...CHANGES, ...CHANGES_3_0 }),
    ...schemaMatrix('3.1.0', { ...CHANGES, ...CHANGES_3_1 }),
  ];
  const verdicts = fixtures.map((fixture) => ({
    fixture,
    expected: expectedForFixture(fixture),
    ...judgeFixture(fixture),
  }));

  it('covers a broad matrix of real structural changes', () => {
    expect(verdicts.length).toBeGreaterThan(2500);
    expect(verdicts.filter((v) => v.edits === 0).map((v) => v.fixture.name)).toEqual([]);
    expect(verdicts.filter((v) => v.bump === 'minor').length).toBeGreaterThan(300);
  });

  it('never judges a change the oracle calls unsafe below major', () => {
    const unsafe = verdicts
      .filter((v) => v.expected === 'major' && v.bump !== 'major')
      .map((v) => `${v.fixture.name} (${v.fixture.base.openapi as string}): ${v.bump}`);
    expect(unsafe).toEqual([]);
  });

  it('agrees with the oracle on every fixture', () => {
    const mismatches = verdicts
      .filter((v) => v.expected !== v.bump)
      .map((v) => `${v.fixture.name}: expected ${v.expected}, got ${v.bump}`);
    expect(mismatches).toEqual([]);
  });
});

/** mulberry32: a small, seeded, reproducible PRNG. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const METHODS = 'get|put|post|delete|options|head|patch|trace|query';
const NAMES = ['a', 'title', 'items', 'properties', 'x-foo', 'required'];
const PARAMETER_KEYS = ['query:q', 'header:X-H', 'cookie:c', 'path:id'];
const ROOTS: readonly (readonly string[])[] = [
  ['paths', '/t', 'post', 'requestBody', 'content', 'application/json', 'schema'],
  ['paths', '/t', 'get', 'parameters', 'KEY', 'schema'],
  ['paths', '/t', 'get', 'parameters', 'KEY', 'content', 'application/json', 'schema'],
  ['paths', '/t', 'parameters', 'KEY', 'schema'],
  ['paths', '/t', 'get', 'responses', '200', 'content', 'application/json', 'schema'],
  ['paths', '/t', 'get', 'responses', '200', 'headers', 'X-H', 'schema'],
  [
    'paths',
    '/t',
    'get',
    'callbacks',
    'cb',
    '{$url}',
    'post',
    'requestBody',
    'content',
    'application/json',
    'schema',
  ],
  [
    'paths',
    '/t',
    'get',
    'callbacks',
    'cb',
    '{$url}',
    'post',
    'responses',
    '200',
    'content',
    'application/json',
    'schema',
  ],
  ['webhooks', 'ping', 'post', 'requestBody', 'content', 'application/json', 'schema'],
  ['components', 'schemas', 'Thing'],
  ['paths', '/t', 'get'],
  ['paths', '/t', 'get', 'parameters', 'KEY'],
  ['paths', '/t', 'parameters', 'KEY'],
  ['paths', '/t', 'get', 'responses', '200', 'headers'],
  ['paths', '/t', 'get', 'responses', '200'],
  ['paths'],
  ['components', 'schemas'],
  ['components', 'parameters'],
  ['servers', '0'],
  ['security', 'key'],
  ['info'],
];
const DESCENTS: readonly (readonly string[])[] = [
  ['properties', 'NAME'],
  ['items'],
  ['allOf', '0'],
  ['additionalProperties'],
  ['anyOf', '1'],
  ['oneOf', '0'],
  ['not'],
  ['if'],
  ['then'],
  ['else'],
  ['prefixItems', '0'],
  ['contains'],
  ['dependentSchemas', 'NAME'],
  ['propertyNames'],
  ['$refSiblings'],
  ['patternProperties', 'NAME'],
];
const TERMINALS: readonly (readonly string[])[] = [
  ['maxLength'],
  ['minLength'],
  ['maximum'],
  ['minimum'],
  ['exclusiveMaximum'],
  ['exclusiveMinimum'],
  ['maxItems'],
  ['minItems'],
  ['pattern'],
  ['enum'],
  ['required'],
  ['additionalProperties'],
  ['type'],
  ['format'],
  ['const'],
  ['default'],
  ['nullable'],
  ['readOnly'],
  ['writeOnly'],
  ['deprecated'],
  ['multipleOf'],
  ['uniqueItems'],
  ['maxProperties'],
  ['minProperties'],
  ['discriminator'],
  ['$refTarget'],
  ['$ref'],
  ['anyOf'],
  ['oneOf'],
  ['allOf'],
  ['not'],
  ['if'],
  ['servers'],
  ['style'],
  ['explode'],
  ['properties', 'NAME'],
  ['properties', 'NAME', 'deprecated'],
  ['x-foo'],
  ['x-enum-varnames'],
  ['x-python-type'],
  ['NAME'],
  ['headers', 'NAME'],
  ['parameters', 'KEY'],
  [],
];
const ACTIONS: readonly EditAction[] = [
  'add',
  'remove',
  'set',
  'unset',
  'change',
  'increase',
  'decrease',
  'reorder',
];
const VALUES: readonly unknown[] = [
  undefined,
  true,
  false,
  0,
  5,
  50,
  'x',
  [],
  ['a'],
  ['a', 'b'],
  {},
  { in: 'query', name: 'q' },
  { in: 'query', name: 'q', required: true },
  { in: 'path', name: 'id', required: true },
  { in: 'header', name: 'X-H' },
  { in: 'cookie', name: 'c', required: false },
  { schema: { type: 'string' } },
  { required: true, schema: { type: 'string' } },
  { type: 'string' },
];

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)] as T;
}

function randomEdit(random: () => number): Edit {
  const name = pick(random, NAMES);
  const key = pick(random, PARAMETER_KEYS);
  const fill = (segment: string): string =>
    segment === 'NAME' ? name : segment === 'KEY' ? key : segment;
  const location = [...pick(random, ROOTS)];
  const depth = Math.floor(random() * 4);
  for (let i = 0; i < depth; i += 1) location.push(...pick(random, DESCENTS));
  const terminal = pick(random, TERMINALS);
  location.push(...terminal);
  const filled = location.map(fill);
  const isExtension = terminal.length === 1 && (terminal[0] ?? '').startsWith('x-');
  return {
    location: filled,
    action: pick(random, ACTIONS),
    before: pick(random, VALUES),
    after: pick(random, VALUES),
    ...(isExtension ? { extension: true as const } : {}),
  };
}

const REQUEST_SCHEMA = String.raw`paths\.[^.]+(\.(${METHODS}))?\.parameters\.(query|header|cookie|path):[^.]+(\.schema|\.content\.[^.]+\.schema)|paths\.[^.]+\.(${METHODS})\.requestBody\.content\.[^.]+\.schema`;
const RESPONSE_SCHEMA = String.raw`paths\.[^.]+\.(${METHODS})\.responses\.[^.]+\.(content\.[^.]+\.schema|headers\.[^.]+\.(schema|content\.[^.]+\.schema))`;
const PLAIN = String.raw`(\.properties\.[^.]+|\.items|\.allOf\.\d+|\.additionalProperties)*`;
const at = (source: string, tail: string): RegExp => new RegExp(`^(${source})${PLAIN}${tail}$`);

const isOptionalParameter = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  ['query', 'header', 'cookie'].includes(String((value as Record<string, unknown>).in)) &&
  (value as Record<string, unknown>).required !== true;

/** The oracle: the allow-list restated as regexes over the dotted location. */
function oracle(edit: Edit): Bump {
  const where = edit.location.join('.');
  const { action, before, after } = edit;
  if (edit.extension === true)
    return isSdkExtension(edit.location.at(-1) ?? '') ? 'major' : 'patch';
  const minor =
    (action === 'add' && new RegExp(`^paths\\.[^.]+(\\.(${METHODS}))?$`).test(where)) ||
    (action === 'add' &&
      new RegExp(`^paths\\.[^.]+(\\.(${METHODS}))?\\.parameters\\.[^.]+$`).test(where) &&
      isOptionalParameter(after)) ||
    (action === 'add' && at(REQUEST_SCHEMA, String.raw`\.properties\.[^.]+`).test(where)) ||
    (action === 'add' && at(RESPONSE_SCHEMA, String.raw`\.properties\.[^.]+`).test(where)) ||
    (at(REQUEST_SCHEMA, String.raw`\.(maxLength|maxItems|maximum|exclusiveMaximum)`).test(where) &&
      (action === 'increase' || action === 'unset')) ||
    (at(REQUEST_SCHEMA, String.raw`\.(minLength|minItems|minimum|exclusiveMinimum)`).test(where) &&
      (action === 'decrease' || action === 'unset')) ||
    (at(REQUEST_SCHEMA, String.raw`\.pattern`).test(where) && action === 'unset') ||
    (at(REQUEST_SCHEMA, String.raw`\.enum`).test(where) &&
      action === 'add' &&
      Array.isArray(before) &&
      before.length > 0 &&
      Array.isArray(after)) ||
    (at(REQUEST_SCHEMA, String.raw`\.required`).test(where) &&
      action === 'remove' &&
      Array.isArray(before)) ||
    (at(REQUEST_SCHEMA, String.raw`\.additionalProperties`).test(where) &&
      before === false &&
      (after === true || after === undefined)) ||
    (new RegExp(
      `^paths\\.[^.]+(\\.(${METHODS}))?\\.parameters\\.(query|header|cookie):[^.]+\\.required$`,
    ).test(where) &&
      action === 'unset' &&
      before === true) ||
    (action === 'add' &&
      new RegExp(`^paths\\.[^.]+\\.(${METHODS})\\.responses\\.[^.]+\\.headers\\.[^.]+$`).test(
        where,
      ) &&
      typeof after === 'object' &&
      after !== null &&
      !Array.isArray(after) &&
      (after as Record<string, unknown>).required !== true) ||
    (action === 'add' && /^components\.schemas\.[^.]+$/.test(where)) ||
    (action === 'set' &&
      after === true &&
      (new RegExp(`^paths\\.[^.]+\\.(${METHODS})\\.deprecated$`).test(where) ||
        new RegExp(`^paths\\.[^.]+(\\.(${METHODS}))?\\.parameters\\.[^.]+\\.deprecated$`).test(
          where,
        ) ||
        at(REQUEST_SCHEMA, String.raw`\.properties\.[^.]+\.deprecated`).test(where) ||
        at(RESPONSE_SCHEMA, String.raw`\.properties\.[^.]+\.deprecated`).test(where)));
  return minor ? 'minor' : 'major';
}

describe('the allow-list against seeded random single edits', () => {
  const random = prng(0x5eed);
  const edits = Array.from({ length: 50_000 }, () => randomEdit(random));
  const empty = { base: {}, revision: {} };
  const verdicts = edits.map((edit) => ({
    edit,
    expected: oracle(edit),
    bump: judgeEdit(edit, empty).bump,
  }));
  const render = (edit: Edit): string =>
    `${edit.location.join('.')}:${edit.action} ${JSON.stringify(edit.before)} -> ${JSON.stringify(edit.after)}`;

  it('generates a mix in which every outcome occurs', () => {
    const count = (bump: Bump): number => verdicts.filter((v) => v.bump === bump).length;
    expect(count('major')).toBeGreaterThan(40_000);
    expect(count('minor')).toBeGreaterThan(200);
    expect(count('patch')).toBeGreaterThan(200);
  });

  it('never judges an edit outside the allow-list below major', () => {
    const unsafe = verdicts
      .filter(
        (v) => RANK[v.bump] < RANK[v.expected] || (v.expected === 'major' && v.bump !== 'major'),
      )
      .map((v) => render(v.edit));
    expect(unsafe).toEqual([]);
  });

  it('agrees with the oracle on every edit', () => {
    const mismatches = verdicts
      .filter((v) => v.expected !== v.bump)
      .map((v) => `${render(v.edit)}: expected ${v.expected}, got ${v.bump}`);
    expect(mismatches.slice(0, 20)).toEqual([]);
  });
});

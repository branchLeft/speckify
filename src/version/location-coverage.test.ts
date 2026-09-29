import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  OASDIFF_LOCATION_CLAIMS_FILENAME,
  OASDIFF_SILENT_CLAIMS_FILENAME,
} from '../oasdiff/version.js';
import {
  findUncoveredEdits,
  loadOasdiffCoverage,
  matchLocation,
  toClaimLocation,
  type OasdiffCoverage,
} from './location-coverage.js';
import type { Edit } from './structural-diff.js';

const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));

function segments(dotted: string): string[] {
  return dotted.split('.');
}

describe('matchLocation (oasdiff MatchLocation semantics)', () => {
  it.each([
    ['paths.*.*', 'paths./a.get', true],
    ['paths.*.*', 'paths./a', false],
    ['paths.*.*', 'paths./a.get.deprecated', false],
    ['a.**.b', 'a.b', true],
    ['a.**.b', 'a.x.y.b', true],
    ['a.**.b', 'a.x.y', false],
    ['**', 'anything.at.all', true],
    ['a.x-*', 'a.x-*', true],
    ['a.x-*', 'a.x-foo', false],
  ])('%s against %s is %s', (pattern, location, expected) => {
    expect(matchLocation(segments(pattern), segments(location))).toBe(expected);
  });

  it('matches whole segments, so a dotted path template is one segment', () => {
    expect(matchLocation(['paths', '*', '*'], ['paths', '/v1.2/a', 'get'])).toBe(true);
  });
});

describe('toClaimLocation', () => {
  const body = 'paths./t.post.requestBody.content.application/json.schema';
  const response = 'paths./t.get.responses.200.content.application/json.schema';

  it.each([
    [`${body}.maxLength`, `${body}.maxLength`, 'root'],
    [`${body}.properties.a.maxLength`, `${body}.maxLength`, 'property'],
    [`${body}.properties.a.properties.b`, `${body}.properties.b`, 'property'],
    [`${body}.properties.a`, `${body}.properties.a`, 'root'],
    [`${body}.items.maxLength`, `${body}.maxLength`, 'subschema'],
    [`${body}.items`, `${body}.items`, 'root'],
    [`${body}.additionalProperties.enum`, `${body}.enum`, 'subschema'],
    [`${body}.anyOf.0.maxLength`, `${body}.maxLength`, 'subschema'],
    [`${body}.allOf.0.nullable`, `${body}.nullable`, 'root+allOf'],
    [`${body}.properties.a.allOf.1.nullable`, `${body}.nullable`, 'property+allOf'],
    [`${body}.allOf.0.properties.a.nullable`, `${body}.nullable`, 'property'],
    [`${body}.oneOf.0.maxLength`, `${body}.oneOf.0.maxLength`, 'root'],
    [`${body}.not.maxLength`, `${body}.not.maxLength`, 'root'],
    [`${body}.properties.a.not.maxLength`, `${body}.not.maxLength`, 'property'],
    [`${response}.items.properties.a.pattern`, `${response}.pattern`, 'property'],
    [`${body}.x-foo`, `${body}.x-*`, 'root'],
    [
      'paths./t.get.parameters.query:q.schema.items.maxLength',
      'paths./t.get.parameters.query:q.schema.items.maxLength',
      'root',
    ],
    [
      'paths./t.post.callbacks.cb.{$url}.post.requestBody.content.a.schema.items.maxLength',
      'paths./t.post.callbacks.cb.{$url}.post.requestBody.content.a.schema.items.maxLength',
      'root',
    ],
  ])('%s collapses to %s (%s)', (concrete, expected, schemaClass) => {
    const result = toClaimLocation(segments(concrete));
    expect(result.location.join('.')).toBe(expected);
    expect(result.schemaClass).toBe(schemaClass);
  });
});

function edit(dotted: string, action: Edit['action'], before?: unknown, after?: unknown): Edit {
  return { location: segments(dotted), action, before, after };
}

describe('findUncoveredEdits against the committed oasdiff 1.32.1 data', () => {
  let coverage: OasdiffCoverage;
  const reported = [
    { path: '/t', operation: 'POST' },
    { path: '/t', operation: 'GET' },
  ];

  beforeAll(async () => {
    coverage = await loadOasdiffCoverage(
      join(dataDir, OASDIFF_LOCATION_CLAIMS_FILENAME),
      join(dataDir, OASDIFF_SILENT_CLAIMS_FILENAME),
    );
  });

  function reasons(edits: Edit[]): string[] {
    return findUncoveredEdits(edits, coverage, reported).map((u) => u.reason);
  }

  it('covers a request-body property maxLength tightening', () => {
    const body = 'paths./t.post.requestBody.content.application/json.schema';
    expect(reasons([edit(`${body}.properties.a.maxLength`, 'decrease', 50, 5)])).toEqual([]);
  });

  it.each([
    [
      'array query param items.maxLength',
      'paths./t.get.parameters.query:q.schema.items.maxLength',
      'decrease',
    ],
    [
      'deepObject property maxLength',
      'paths./t.get.parameters.query:f.schema.properties.name.maxLength',
      'decrease',
    ],
    [
      'callback payload enum',
      'paths./t.post.callbacks.cb.{$url}.post.requestBody.content.application/json.schema.properties.status.enum',
      'add',
    ],
    ['callback removed', 'paths./t.post.callbacks.cb', 'remove'],
    [
      'a oneOf branch relaxed',
      'paths./t.post.requestBody.content.application/json.schema.oneOf.0.maxLength',
      'increase',
    ],
    [
      'a not schema relaxed',
      'paths./t.post.requestBody.content.application/json.schema.not.maxLength',
      'increase',
    ],
    ['a server URL', 'servers.0.url', 'change'],
    ['an unreferenced component', 'components.headers.Rate', 'remove'],
  ] as const)('leaves %s uncovered', (_name, location, action) => {
    expect(reasons([edit(location, action)])).toEqual(['no-claim']);
  });

  it('treats a claim oasdiff declares but does not honour as uncovered', () => {
    const body = 'paths./t.post.requestBody.content.application/json.schema';
    expect(reasons([edit(`${body}.pattern`, 'change', '^a', '^b')])).toEqual(['silent-claim']);
    expect(reasons([edit(`${body}.properties.a.pattern`, 'change', '^a', '^b')])).toEqual([]);
  });

  it('matches vendor extensions through the x-* segment, and honours silent entries for them', () => {
    expect(reasons([edit('paths./t.get.x-internal', 'change', 1, 2)])).toEqual(['silent-claim']);
  });

  it('treats a new constraint on a request schema as MAJOR whatever the claim says', () => {
    const param = 'paths./t.get.parameters.query:q.schema';
    expect(reasons([edit(`${param}.enum`, 'add', undefined, ['a', 'b'])])).toEqual([
      'new-request-constraint',
    ]);
    const body = 'paths./t.post.requestBody.content.application/json.schema.properties.a';
    expect(reasons([edit(`${body}.maxLength`, 'set', undefined, 5)])).toEqual([
      'new-request-constraint',
    ]);
    expect(reasons([edit(`${body}.required`, 'add', [], ['x'])])).toEqual([
      'new-request-constraint',
    ]);
    expect(reasons([edit(`${body}.maxLength`, 'decrease', 9, 5)])).toEqual([]);
  });

  it('does not treat a new constraint on a response schema as a request narrowing', () => {
    const response = 'paths./t.get.responses.200.content.application/json.schema.properties.a';
    expect(reasons([edit(`${response}.maxLength`, 'set', undefined, 5)])).toEqual([]);
  });

  it('requires oasdiff to have reported something for the edited operation', () => {
    const body = 'paths./other.post.requestBody.content.application/json.schema.properties.a';
    expect(reasons([edit(`${body}.maxLength`, 'decrease', 9, 5)])).toEqual([
      'unreported-operation',
    ]);
    const pathLevel = 'paths./other.parameters.query:q';
    expect(findUncoveredEdits([edit(pathLevel, 'add')], coverage, [{ path: '/other' }])).toEqual(
      [],
    );
  });
});

describe('loadOasdiffCoverage', () => {
  it('rejects data pinned to a different oasdiff version', async () => {
    await expect(
      loadOasdiffCoverage(
        join(dataDir, OASDIFF_LOCATION_CLAIMS_FILENAME),
        join(dataDir, OASDIFF_SILENT_CLAIMS_FILENAME),
        { expectedOasdiffVersion: '999.0.0' },
      ),
    ).rejects.toThrow(/pinned to oasdiff/);
  });
});

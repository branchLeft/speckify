import { describe, expect, it } from 'vitest';

import { checkParameterNames, RULE_ID } from './parameter-names.js';

function docWith(
  parameters: unknown[],
  pathParameters: unknown[] = [],
  components: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    paths: {
      '/things/{id}': {
        parameters: pathParameters,
        get: { operationId: 'search', parameters },
      },
    },
    components: { parameters: components },
  };
}

describe('checkParameterNames', () => {
  it('finds nothing when every parameter name is distinct after normalisation', () => {
    const doc = docWith([
      { name: 'id', in: 'path', required: true },
      { name: 'page_size', in: 'query' },
      { name: 'X-Trace', in: 'header' },
    ]);
    expect(checkParameterNames(doc)).toEqual([]);
  });

  it('refuses a Page-Size header beside a page_size query parameter', () => {
    const doc = docWith([
      { name: 'page_size', in: 'query' },
      { name: 'Page-Size', in: 'header' },
    ]);
    const findings = checkParameterNames(doc);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: RULE_ID,
      pointer: '/paths/~1things~1{id}/get/parameters/1',
    });
    expect(findings[0]?.message).toContain('"Page-Size" (header)');
    expect(findings[0]?.message).toContain('"page_size" (query)');
  });

  it('refuses a query parameter sharing a path-level path parameter name', () => {
    const doc = docWith(
      [{ name: 'id', in: 'query' }],
      [{ name: 'id', in: 'path', required: true }],
    );
    const findings = checkParameterNames(doc);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.pointer).toBe('/paths/~1things~1{id}/get/parameters/0');
  });

  it('lets an operation parameter override a path-level one with the same name and location', () => {
    const doc = docWith(
      [{ name: 'id', in: 'path', required: true, description: 'override' }],
      [{ name: 'id', in: 'path', required: true }],
    );
    expect(checkParameterNames(doc)).toEqual([]);
  });

  it('resolves a local $ref to a components parameter', () => {
    const doc = docWith(
      [{ name: 'pageSize', in: 'query' }, { $ref: '#/components/parameters/PageSize' }],
      [],
      { PageSize: { name: 'page-size', in: 'header' } },
    );
    expect(checkParameterNames(doc)).toHaveLength(1);
  });

  it('skips parameters it cannot read: unresolvable refs, nameless entries, non-objects', () => {
    const doc = docWith([
      { $ref: '#/components/parameters/Missing' },
      { in: 'query' },
      'not-a-parameter',
      { name: 'q', in: 'query' },
    ]);
    expect(checkParameterNames(doc)).toEqual([]);
  });

  it('checks path-level parameters alone on a path with no operations', () => {
    const doc = {
      paths: {
        '/a': {
          parameters: [
            { name: 'x_y', in: 'query' },
            { name: 'X-Y', in: 'header' },
          ],
        },
        '/b': null,
      },
    };
    expect(checkParameterNames(doc)).toHaveLength(1);
  });

  it('returns nothing without paths', () => {
    expect(checkParameterNames({})).toEqual([]);
  });
});

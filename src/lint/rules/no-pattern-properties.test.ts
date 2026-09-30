import { describe, expect, it } from 'vitest';

import { checkNoPatternProperties, RULE_ID } from './no-pattern-properties.js';

describe('checkNoPatternProperties', () => {
  it('finds no problem in a document without patternProperties', () => {
    const doc = { components: { schemas: { Widget: { type: 'object', properties: {} } } } };
    expect(checkNoPatternProperties(doc)).toEqual([]);
  });

  it('reports patternProperties wherever it appears, with a JSON pointer', () => {
    const doc = {
      components: {
        schemas: {
          Config: {
            type: 'object',
            properties: { id: { type: 'string' } },
            patternProperties: { '^x-': { type: 'string' } },
          },
        },
      },
    };

    const findings = checkNoPatternProperties(doc);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: RULE_ID,
      pointer: '/components/schemas/Config/patternProperties',
    });
    expect(findings[0]?.message).toMatch(/additionalProperties/);
  });

  it('reports every occurrence, deeply nested and repeated', () => {
    const doc = {
      a: { patternProperties: {} },
      b: { c: { patternProperties: {} } },
    };
    const findings = checkNoPatternProperties(doc);
    expect(findings.map((f) => f.pointer).sort()).toEqual([
      '/a/patternProperties',
      '/b/c/patternProperties',
    ]);
  });

  it('walks into arrays (e.g. anyOf/allOf/oneOf members) and finds patternProperties there', () => {
    const doc = { anyOf: [{ type: 'string' }, { patternProperties: {} }] };
    const findings = checkNoPatternProperties(doc);
    expect(findings.map((f) => f.pointer)).toEqual(['/anyOf/1/patternProperties']);
  });

  it('ignores a scalar or null value at any node instead of throwing', () => {
    const doc = { description: 'a plain string node', extra: null, count: 5 };
    expect(checkNoPatternProperties(doc)).toEqual([]);
  });
});

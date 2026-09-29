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
});

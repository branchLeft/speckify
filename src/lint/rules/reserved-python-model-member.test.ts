import { describe, expect, it } from 'vitest';

import { checkReservedPythonModelMembers, RULE_ID } from './reserved-python-model-member.js';

function specWithSchemaProperty(propertyName: string): unknown {
  return {
    openapi: '3.0.3',
    info: { title: 'Widgets', version: '1.0.0' },
    paths: {},
    components: {
      schemas: {
        Thing: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            [propertyName]: { type: 'string' },
          },
        },
      },
    },
  };
}

describe('checkReservedPythonModelMembers', () => {
  it.each(['to_dict', 'from_dict', 'additional_properties', 'additional_keys'])(
    'refuses a property named exactly "%s"',
    (name) => {
      const findings = checkReservedPythonModelMembers(specWithSchemaProperty(name));
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: RULE_ID,
        pointer: `/components/schemas/Thing/properties/${name}`,
      });
      expect(findings[0]?.message).toContain(name);
    },
  );

  it.each([
    ['ToDict', 'to_dict'],
    ['TO_DICT', 'to_dict'],
    ['FromDict', 'from_dict'],
    ['AdditionalProperties', 'additional_properties'],
    ['Additional-Properties', 'additional_properties'],
  ])('refuses "%s", which python-normalises to the reserved "%s"', (name) => {
    const findings = checkReservedPythonModelMembers(specWithSchemaProperty(name));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe(RULE_ID);
  });

  it('is fine with an ordinary property', () => {
    expect(checkReservedPythonModelMembers(specWithSchemaProperty('nickname'))).toEqual([]);
  });

  it('is fine with a document that has no schemas at all', () => {
    const doc = { openapi: '3.0.3', info: { title: 'x', version: '1.0.0' }, paths: {} };
    expect(checkReservedPythonModelMembers(doc)).toEqual([]);
  });

  it('catches the collision inside an inline request body schema, not only components.schemas', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 'Widgets', version: '1.0.0' },
      paths: {
        '/widgets': {
          post: {
            operationId: 'createWidget',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { to_dict: { type: 'string' } },
                  },
                },
              },
            },
            responses: {},
          },
        },
      },
    };
    const findings = checkReservedPythonModelMembers(doc);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.pointer).toBe(
      '/paths/~1widgets/post/requestBody/content/application~1json/schema/properties/to_dict',
    );
  });
});

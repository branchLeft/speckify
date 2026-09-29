import { describe, expect, it } from 'vitest';

import { checkOperationIds, RULE_ID } from './operation-id.js';

describe('checkOperationIds', () => {
  it('finds no problem when every operation has a unique operationId', () => {
    const doc = {
      paths: {
        '/widgets': {
          get: { operationId: 'listWidgets' },
          post: { operationId: 'createWidget' },
        },
      },
    };
    expect(checkOperationIds(doc)).toEqual([]);
  });

  it('reports an operation missing operationId', () => {
    const doc = { paths: { '/widgets': { get: {} } } };
    const findings = checkOperationIds(doc);
    expect(findings).toEqual([
      { ruleId: RULE_ID, pointer: '/paths/~1widgets/get', message: 'operation has no operationId' },
    ]);
  });

  it('reports a duplicate operationId, pointing at the second occurrence', () => {
    const doc = {
      paths: {
        '/widgets': { get: { operationId: 'sameId' } },
        '/gadgets': { get: { operationId: 'sameId' } },
      },
    };
    const findings = checkOperationIds(doc);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: RULE_ID,
      pointer: '/paths/~1gadgets/get/operationId',
    });
    expect(findings[0]?.message).toContain('sameId');
    expect(findings[0]?.message).toContain('/paths/~1widgets/get/operationId');
  });

  it('ignores non-HTTP-method keys on a path item, like parameters', () => {
    const doc = { paths: { '/widgets': { parameters: [], get: { operationId: 'listWidgets' } } } };
    expect(checkOperationIds(doc)).toEqual([]);
  });

  it('returns no findings when the document has no paths', () => {
    expect(checkOperationIds({})).toEqual([]);
  });

  it('skips a path item that is not an object, such as a malformed $ref left unresolved', () => {
    const doc = {
      paths: { '/widgets': null, '/gadgets': { get: { operationId: 'listGadgets' } } },
    };
    expect(checkOperationIds(doc)).toEqual([]);
  });

  it('reports a missing operationId when the operation value itself is not an object', () => {
    const doc = { paths: { '/widgets': { get: 'not-an-operation' } } };
    const findings = checkOperationIds(doc);
    expect(findings).toEqual([
      { ruleId: RULE_ID, pointer: '/paths/~1widgets/get', message: 'operation has no operationId' },
    ]);
  });

  it.each([
    ['createThing', 'CreateThing'],
    ['createThing', 'create_thing'],
    ['create-thing', 'createThing'],
    ['getHTTPThing', 'get_http_thing'],
  ])('refuses %s beside %s: they collide once case and separators are normalised', (a, b) => {
    const doc = {
      paths: {
        '/things': { post: { operationId: a } },
        '/other': { post: { operationId: b } },
      },
    };
    const findings = checkOperationIds(doc);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.pointer).toBe('/paths/~1other/post/operationId');
    expect(findings[0]?.message).toContain(`"${b}"`);
    expect(findings[0]?.message).toContain(`"${a}"`);
    expect(findings[0]?.message).toContain('/paths/~1things/post/operationId');
  });

  it('allows operationIds that differ in more than case and separators', () => {
    const doc = {
      paths: {
        '/things': { post: { operationId: 'createThing' }, get: { operationId: 'createThings' } },
      },
    };
    expect(checkOperationIds(doc)).toEqual([]);
  });
});

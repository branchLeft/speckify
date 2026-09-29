import { describe, expect, it } from 'vitest';

import { diffDocuments, prepareDocument, stripDocOnlyKeys, type Edit } from './structural-diff.js';

type Doc = Record<string, unknown>;

function doc(paths: Doc, extra: Doc = {}): Doc {
  return { openapi: '3.0.3', info: { title: 'T', version: '1.0.0' }, paths, ...extra };
}

function op(schema: unknown, where: 'body' | 'response' | 'query' = 'body'): Doc {
  const operation: Doc = { responses: { '200': { description: 'ok' } } };
  if (where === 'body') {
    operation.requestBody = { content: { 'application/json': { schema } } };
  } else if (where === 'response') {
    operation.responses = {
      '200': { description: 'ok', content: { 'application/json': { schema } } },
    };
  } else {
    operation.parameters = [{ name: 'q', in: 'query', schema }];
  }
  return operation;
}

function edits(base: Doc, revision: Doc): string[] {
  return diffDocuments(prepareDocument(base), prepareDocument(revision)).map(render);
}

function render(edit: Edit): string {
  return `${edit.location.join('.')}:${edit.action}`;
}

const BODY = 'paths./things.post.requestBody.content.application/json.schema';

describe('diffDocuments: scalar and list actions', () => {
  it.each([
    [{ maxLength: 50 }, { maxLength: 5 }, `${BODY}.maxLength:decrease`],
    [{ maxLength: 5 }, { maxLength: 50 }, `${BODY}.maxLength:increase`],
    [{}, { maxLength: 5 }, `${BODY}.maxLength:set`],
    [{ maxLength: 5 }, {}, `${BODY}.maxLength:unset`],
    [{}, { pattern: '^a' }, `${BODY}.pattern:set`],
    [{ pattern: '^a' }, { pattern: '^b' }, `${BODY}.pattern:change`],
    [{ pattern: '^a' }, {}, `${BODY}.pattern:unset`],
    [{}, { nullable: true }, `${BODY}.nullable:set`],
    [{ nullable: true }, { nullable: false }, `${BODY}.nullable:unset`],
    [{ default: 'a' }, { default: 'b' }, `${BODY}.default:change`],
    [{ default: { a: 1 } }, { default: { a: 2 } }, `${BODY}.default:change`],
    [{}, { additionalProperties: false }, `${BODY}.additionalProperties:set`],
    [
      { additionalProperties: true },
      { additionalProperties: false },
      `${BODY}.additionalProperties:change`,
    ],
  ])('%j -> %j gives %s', (before, after, expected) => {
    const base = doc({ '/things': { post: op({ type: 'string', ...before }) } });
    const revision = doc({ '/things': { post: op({ type: 'string', ...after }) } });
    expect(edits(base, revision)).toEqual([expected]);
  });

  it('reports each list member added or removed once per action', () => {
    const base = doc({ '/things': { post: op({ type: 'string', enum: ['a', 'b'] }) } });
    const revision = doc({ '/things': { post: op({ type: 'string', enum: ['b', 'c', 'd'] }) } });
    expect(edits(base, revision).sort()).toEqual([`${BODY}.enum:add`, `${BODY}.enum:remove`]);
  });

  it('treats a type change as a remove plus an add, and 3.0 and 3.1 spellings alike', () => {
    const base = doc({ '/things': { post: op({ type: 'string' }) } });
    const revision = doc({ '/things': { post: op({ type: ['integer'] }) } });
    expect(edits(base, revision).sort()).toEqual([`${BODY}.type:add`, `${BODY}.type:remove`]);
    const same = doc({ '/things': { post: op({ type: ['string'] }) } });
    expect(edits(base, same)).toEqual([]);
  });

  it('writes a vendor extension edit at its own name, with add/change/remove', () => {
    const base = doc({ '/things': { post: op({ type: 'string', 'x-a': 1, 'x-b': 1 }) } });
    const revision = doc({ '/things': { post: op({ type: 'string', 'x-a': 2, 'x-c': 1 }) } });
    expect(edits(base, revision).sort()).toEqual([
      `${BODY}.x-a:change`,
      `${BODY}.x-b:remove`,
      `${BODY}.x-c:add`,
    ]);
    const flagged = diffDocuments(prepareDocument(base), prepareDocument(revision));
    expect(flagged.every((edit) => edit.extension === true)).toBe(true);
  });

  it('does not flag a member name that merely starts with x- as an extension', () => {
    const withHeader = (headers: Doc): Doc =>
      doc({ '/t': { get: { responses: { '200': { description: 'ok', headers } } } } });
    const base = withHeader({ 'x-request-id': { schema: { type: 'string' } } });
    const [edit] = diffDocuments(prepareDocument(base), prepareDocument(withHeader({})));
    expect(edit?.location.at(-1)).toBe('x-request-id');
    expect(edit?.action).toBe('remove');
    expect(edit?.extension).toBeUndefined();
  });
});

describe('diffDocuments: members of name maps and keyed lists', () => {
  it('reports a property, a path and an operation added or removed as members', () => {
    const base = doc({
      '/things': { post: op({ type: 'object', properties: { a: { type: 'string' } } }) },
      '/gone': { get: op({}) },
    });
    const revision = doc({
      '/things': {
        post: op({ type: 'object', properties: { b: { type: 'string' } } }),
        get: op({}),
      },
    });
    expect(edits(base, revision).sort()).toEqual([
      'paths./gone:remove',
      'paths./things.get:add',
      `${BODY}.properties.a:remove`,
      `${BODY}.properties.b:add`,
    ]);
  });

  it('addresses parameters by in:name, so a reorder is one reorder edit, not member edits', () => {
    const a = { name: 'a', in: 'query', schema: { type: 'string' } };
    const b = { name: 'b', in: 'header', schema: { type: 'string' } };
    const base = doc({ '/t': { get: { parameters: [a, b], responses: {} } } });
    const reordered = doc({ '/t': { get: { parameters: [b, a], responses: {} } } });
    expect(edits(base, reordered)).toEqual(['paths./t.get.parameters:reorder']);
    const inserted = doc({
      '/t': { get: { parameters: [a, { ...a, name: 'c' }, b], responses: {} } },
    });
    expect(edits(base, inserted)).toEqual(['paths./t.get.parameters.query:c:add']);
    const tightened = doc({
      '/t': {
        get: { parameters: [{ ...a, schema: { type: 'string', maxLength: 3 } }, b], responses: {} },
      },
    });
    expect(edits(base, tightened)).toEqual([
      'paths./t.get.parameters.query:a.schema.maxLength:set',
    ]);
  });

  it('does not split a path template containing dots into several segments', () => {
    const base = doc({ '/v1.2/things': { get: op({ type: 'string' }, 'query') } });
    const revision = doc({ '/v1.2/things': { get: op({ type: 'integer' }, 'query') } });
    const [first] = diffDocuments(prepareDocument(base), prepareDocument(revision));
    expect(first?.location.slice(0, 3)).toEqual(['paths', '/v1.2/things', 'get']);
  });

  it('keys security requirements by their scheme names and diffs scopes as members', () => {
    const base = doc({}, { security: [{ oauth: ['read'] }, { key: [] }] });
    const revision = doc({}, { security: [{ key: [] }, { oauth: ['read', 'write'] }] });
    expect(edits(base, revision)).toEqual(['security.oauth.oauth:add']);
  });
});

describe('prepareDocument: dereferencing', () => {
  const component = (maxLength: number): Doc => ({
    Name: { type: 'string', maxLength },
  });

  it('surfaces a component change at every concrete use site', () => {
    const ref = { $ref: '#/components/schemas/Name' };
    const base = doc({ '/things': { post: op(ref) } }, { components: { schemas: component(50) } });
    const revision = doc(
      { '/things': { post: op(ref) } },
      { components: { schemas: component(5) } },
    );
    expect(edits(base, revision)).toEqual([`${BODY}.maxLength:decrease`]);
  });

  it('reports an unreferenced component content change at the component itself', () => {
    const base = doc({}, { components: { schemas: component(50) } });
    const revision = doc({}, { components: { schemas: component(5) } });
    expect(edits(base, revision)).toEqual(['components.schemas.Name:change']);
  });

  it('reports unreferenced components added or removed, but not referenced ones', () => {
    const ref = { $ref: '#/components/headers/Used' };
    const header = { schema: { type: 'string' } };
    const response = (headers: Doc): Doc => ({
      responses: { '200': { description: 'ok', headers } },
    });
    const base = doc(
      { '/t': { get: response({}) } },
      { components: { headers: { Unused: header } } },
    );
    const revision = doc(
      { '/t': { get: response({ 'X-Used': ref }) } },
      { components: { headers: { Used: header } } },
    );
    expect(edits(base, revision).sort()).toEqual([
      'components.headers.Unused:remove',
      'paths./t.get.responses.200.headers.X-Used:add',
    ]);
  });

  it('marks an inlined component schema with its target, so a retarget is an edit', () => {
    const schemas = { Name: { type: 'string' }, Loose: { type: 'string' } };
    const at = (target: string): Doc =>
      doc(
        { '/things': { post: op({ $ref: `#/components/schemas/${target}` }) } },
        {
          components: { schemas },
        },
      );
    expect(edits(at('Name'), at('Loose'))).toEqual([`${BODY}.$refTarget:change`]);
    const inline = doc(
      { '/things': { post: op({ type: 'string' }) } },
      { components: { schemas } },
    );
    expect(edits(inline, at('Name'))).toEqual([`${BODY}.$refTarget:set`]);
  });

  it('leaves a $ref inside a vendor extension alone, so it references nothing', () => {
    const schemas = { Hidden: { type: 'string' } };
    const extended = doc(
      {
        '/things': {
          post: { ...op({ type: 'string' }), 'x-model': { $ref: '#/components/schemas/Hidden' } },
        },
      },
      { components: { schemas } },
    );
    const prepared = prepareDocument(extended);
    expect(prepared.referenced.has('schemas/Hidden')).toBe(false);
    const changed = doc(
      {
        '/things': {
          post: { ...op({ type: 'string' }), 'x-model': { $ref: '#/components/schemas/Hidden' } },
        },
      },
      { components: { schemas: { Hidden: { type: 'string', maxLength: 3 } } } },
    );
    expect(edits(extended, changed)).toEqual(['components.schemas.Hidden:change']);
  });

  it('marks a recursive schema cyclic, so its change is reported at the component', () => {
    const node = (maxLength: number): Doc => ({
      Node: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength },
          child: { $ref: '#/components/schemas/Node' },
        },
      },
    });
    const ref = { $ref: '#/components/schemas/Node' };
    const base = doc({ '/things': { post: op(ref) } }, { components: { schemas: node(50) } });
    const revision = doc({ '/things': { post: op(ref) } }, { components: { schemas: node(5) } });
    const prepared = prepareDocument(base);
    expect(prepared.cyclic.has('schemas/Node')).toBe(true);
    expect(edits(base, revision)).toContain('components.schemas.Node:change');
  });

  it('keeps sibling keys of a $ref apart, and an unresolvable $ref as it is', () => {
    const base = doc({ '/things': { post: op({ $ref: '#/components/schemas/Missing' }) } });
    const revision = doc({ '/things': { post: op({ $ref: '#/components/schemas/Other' }) } });
    expect(edits(base, revision)).toEqual([`${BODY}.$ref:change`]);

    const withSibling = (maxLength: number): Doc =>
      doc(
        { '/things': { post: op({ $ref: '#/components/schemas/Name', maxLength }) } },
        { components: { schemas: component(50) } },
      );
    expect(edits(withSibling(9), withSibling(3))).toEqual([
      `${BODY}.$refSiblings.maxLength:decrease`,
    ]);
  });

  it('decodes JSON-pointer escapes when resolving a reference', () => {
    const shared = { $ref: '#/paths/~1a/get/responses/200' };
    const response = (maxLength: number): Doc => ({
      description: 'ok',
      content: { 'application/json': { schema: { type: 'string', maxLength } } },
    });
    const build = (maxLength: number): Doc =>
      doc({
        '/a': { get: { responses: { '200': response(maxLength) } } },
        '/b': { get: { responses: { '200': shared } } },
      });
    expect(edits(build(9), build(3)).sort()).toEqual([
      'paths./a.get.responses.200.content.application/json.schema.maxLength:decrease',
      'paths./b.get.responses.200.content.application/json.schema.maxLength:decrease',
    ]);
  });
});

describe('prepareDocument: normalisation', () => {
  it('ignores info.version, doc-only annotations, root tags and info metadata', () => {
    const base = doc({ '/t': { get: { summary: 'a', responses: {} } } }, { tags: [{ name: 'a' }] });
    const revision = {
      ...doc({ '/t': { get: { summary: 'b', responses: {} } } }, { tags: [{ name: 'b' }] }),
      info: { title: 'Other', version: '9.9.9', contact: { email: 'a@example.com' } },
    };
    expect(edits(base, revision)).toEqual([]);
  });

  it('keeps a property whose name is also an annotation keyword', () => {
    const schema = (maxLength: number): Doc => ({
      type: 'object',
      properties: { title: { type: 'string', maxLength } },
    });
    const base = doc({ '/things': { post: op(schema(9)) } });
    const revision = doc({ '/things': { post: op(schema(3)) } });
    expect(edits(base, revision)).toEqual([`${BODY}.properties.title.maxLength:decrease`]);
  });

  it('never strips inside a default, const or enum value', () => {
    const withDefault = (title: string): Doc =>
      doc({ '/things': { post: op({ type: 'object', default: { title } }) } });
    expect(edits(withDefault('a'), withDefault('b'))).toEqual([`${BODY}.default:change`]);
    expect(stripDocOnlyKeys({ enum: [{ description: 'x' }] })).toEqual({
      enum: [{ description: 'x' }],
    });
  });

  it('strips annotations only in annotation position', () => {
    expect(
      stripDocOnlyKeys({ description: 'x', properties: { description: { description: 'y' } } }),
    ).toEqual({ properties: { description: {} } });
  });
});

import { describe, expect, it } from 'vitest';

import {
  ALLOW_LIST,
  allowListBump,
  directionOf,
  isPlainPosition,
  isSdkExtension,
  judgeEdits,
  valueAt,
} from './allow-list.js';
import { diffDocuments, prepareDocument } from './structural-diff.js';
import type { Bump } from './types.js';

type Doc = Record<string, unknown>;

const S = (extra: Doc = {}): Doc => ({ type: 'string', ...extra });
const OK = { '200': { description: 'ok' } };

function doc(paths: Doc, extra: Doc = {}): Doc {
  return { openapi: '3.0.3', info: { title: 'T', version: '1.0.0' }, paths, ...extra };
}

const body = (schema: Doc): Doc => ({
  requestBody: { content: { 'application/json': { schema } } },
  responses: OK,
});
const response = (schema: Doc): Doc => ({
  responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
});
const responseHeader = (schema: Doc): Doc => ({
  responses: { '200': { description: 'ok', headers: { 'X-H': { schema } } } },
});
const callback = (operation: Doc): Doc => ({
  callbacks: { done: { '{$request.body#/url}': { post: operation } } },
  responses: OK,
});

/** The allow-list's bump and the rules that matched, for one base → revision pair. */
function verdict(base: Doc, revision: Doc): { bump: Bump; rules: string[] } {
  const a = prepareDocument(base);
  const b = prepareDocument(revision);
  const judgements = judgeEdits(diffDocuments(a, b), { base: a.doc, revision: b.doc });
  return {
    bump: allowListBump(judgements),
    rules: judgements.map((j) => j.rule ?? 'major'),
  };
}

const onPost = (before: Doc, after: Doc): [Doc, Doc] => [
  doc({ '/t': { post: before } }),
  doc({ '/t': { post: after } }),
];

describe('the allow-list table', () => {
  it('names each rule once, with a reason', () => {
    const names = ALLOW_LIST.map((rule) => rule.name);
    expect(new Set(names).size).toBe(names.length);
    expect(ALLOW_LIST.every((rule) => rule.reason.length > 0 && rule.bump === 'minor')).toBe(true);
    expect(names).toEqual([
      'operation-added',
      'optional-parameter-added',
      'request-optional-property-added',
      'request-constraint-relaxed',
      'parameter-became-optional',
      'response-optional-property-added',
      'response-optional-header-added',
      'unreferenced-schema-added',
      'deprecated-set',
    ]);
  });
});

describe('operation-added', () => {
  it('is minor for a new path and for a new method on an existing path', () => {
    const base = doc({ '/t': { get: { responses: OK } } });
    expect(
      verdict(base, doc({ '/t': { get: { responses: OK } }, '/u': { get: { responses: OK } } })),
    ).toEqual({
      bump: 'minor',
      rules: ['operation-added'],
    });
    expect(
      verdict(base, doc({ '/t': { get: { responses: OK }, post: { responses: OK } } })).bump,
    ).toBe('minor');
  });

  it('is major for a new webhook or a new callback, where the direction inverts', () => {
    const base = { ...doc({ '/t': { get: { responses: OK } } }), openapi: '3.1.0', webhooks: {} };
    const webhook = { ...base, webhooks: { ping: { post: { responses: OK } } } };
    expect(verdict(base, webhook).bump).toBe('major');
    const [before, after] = onPost({ responses: OK }, callback({ responses: OK }));
    expect(verdict(before, after).bump).toBe('major');
  });

  it('is major for an operation removed', () => {
    const base = doc({ '/t': { get: { responses: OK }, post: { responses: OK } } });
    expect(verdict(base, doc({ '/t': { get: { responses: OK } } })).bump).toBe('major');
  });
});

describe('optional-parameter-added', () => {
  const param = (extra: Doc): Doc => ({ name: 'q', in: 'query', schema: S(), ...extra });

  it.each(['query', 'header', 'cookie'])('is minor for a new optional %s parameter', (location) => {
    const [base, revision] = onPost(
      { responses: OK },
      { parameters: [param({ in: location })], responses: OK },
    );
    expect(verdict(base, revision)).toEqual({ bump: 'minor', rules: ['optional-parameter-added'] });
  });

  it('is minor for a new optional path-level parameter', () => {
    const base = doc({ '/t': { get: { responses: OK } } });
    const revision = doc({ '/t': { parameters: [param({})], get: { responses: OK } } });
    expect(verdict(base, revision).bump).toBe('minor');
  });

  it('is major for a required parameter, a path parameter, or one shadowing a path-level parameter', () => {
    let [base, revision] = onPost(
      { responses: OK },
      { parameters: [param({ required: true })], responses: OK },
    );
    expect(verdict(base, revision).bump).toBe('major');
    [base, revision] = [
      doc({ '/t/{id}': { post: { responses: OK } } }),
      doc({
        '/t/{id}': {
          post: {
            parameters: [{ name: 'id', in: 'path', required: true, schema: S() }],
            responses: OK,
          },
        },
      }),
    ];
    expect(verdict(base, revision).bump).toBe('major');
    const pathLevel = { parameters: [param({})] };
    base = doc({ '/t': { ...pathLevel, post: { responses: OK } } });
    revision = doc({
      '/t': {
        ...pathLevel,
        post: { parameters: [param({ schema: S({ maxLength: 3 }) })], responses: OK },
      },
    });
    expect(verdict(base, revision).bump).toBe('major');
  });

  it('is major for the same parameter added to a callback operation (direction test)', () => {
    const [base, revision] = onPost(
      callback({ responses: OK }),
      callback({ parameters: [param({})], responses: OK }),
    );
    expect(verdict(base, revision).bump).toBe('major');
  });
});

const object = (properties: Doc, extra: Doc = {}): Doc => ({
  type: 'object',
  properties,
  ...extra,
});

describe('request-optional-property-added', () => {
  it('is minor for a new optional request property, nested or not', () => {
    const [base, revision] = onPost(body(object({ a: S() })), body(object({ a: S(), b: S() })));
    expect(verdict(base, revision)).toEqual({
      bump: 'minor',
      rules: ['request-optional-property-added'],
    });
    const nested = (props: Doc): Doc =>
      body(object({ outer: { type: 'array', items: object(props) } }));
    const [b2, r2] = onPost(nested({ a: S() }), nested({ a: S(), b: S() }));
    expect(verdict(b2, r2).bump).toBe('minor');
  });

  it('is major for a new required request property', () => {
    const [base, revision] = onPost(
      body(object({ a: S() })),
      body(object({ a: S(), b: S() }, { required: ['b'] })),
    );
    expect(verdict(base, revision).bump).toBe('major');
  });

  it('is major inside a oneOf branch, where a new property can make a value match twice', () => {
    const branch = (props: Doc): Doc =>
      body({ oneOf: [object(props, { additionalProperties: false }), S()] });
    const [base, revision] = onPost(branch({ a: S() }), branch({ a: S(), b: S() }));
    expect(verdict(base, revision).bump).toBe('major');
  });

  it('is major for the same property added to a callback request body (direction test)', () => {
    const [base, revision] = onPost(
      callback(body(object({ a: S() }))),
      callback(body(object({ a: S(), b: S() }))),
    );
    expect(verdict(base, revision).bump).toBe('major');
  });
});

/** [keyword change name, before schema, after schema] for every relaxation the rule names. */
const RELAXATIONS: readonly (readonly [string, Doc, Doc])[] = [
  ['maxLength raised', S({ maxLength: 5 }), S({ maxLength: 50 })],
  ['maxLength removed', S({ maxLength: 5 }), S()],
  [
    'maxItems raised',
    { type: 'array', items: S(), maxItems: 2 },
    { type: 'array', items: S(), maxItems: 5 },
  ],
  ['maximum removed', { type: 'integer', maximum: 5 }, { type: 'integer' }],
  [
    'exclusiveMaximum (3.0 boolean) removed',
    { type: 'integer', maximum: 5, exclusiveMaximum: true },
    { type: 'integer', maximum: 5 },
  ],
  ['minLength lowered', S({ minLength: 5 }), S({ minLength: 1 })],
  ['minItems removed', { type: 'array', items: S(), minItems: 2 }, { type: 'array', items: S() }],
  ['minimum lowered', { type: 'integer', minimum: 5 }, { type: 'integer', minimum: 1 }],
  [
    'exclusiveMinimum (3.0 boolean) removed',
    { type: 'integer', minimum: 1, exclusiveMinimum: true },
    { type: 'integer', minimum: 1 },
  ],
  ['pattern removed', S({ pattern: '^a' }), S()],
  ['enum value added', S({ enum: ['a'] }), S({ enum: ['a', 'b'] })],
  [
    'required member removed',
    object({ a: S(), b: S() }, { required: ['a', 'b'] }),
    object({ a: S(), b: S() }, { required: ['a'] }),
  ],
  [
    'additionalProperties false → true',
    object({ a: S() }, { additionalProperties: false }),
    object({ a: S() }, { additionalProperties: true }),
  ],
  [
    'additionalProperties false → removed',
    object({ a: S() }, { additionalProperties: false }),
    object({ a: S() }),
  ],
];

describe('request-constraint-relaxed', () => {
  it.each(RELAXATIONS)('%s in a request body is minor', (_name, before, after) => {
    const [base, revision] = onPost(body(object({ p: before })), body(object({ p: after })));
    expect(verdict(base, revision)).toEqual({
      bump: 'minor',
      rules: ['request-constraint-relaxed'],
    });
  });

  it.each(RELAXATIONS)('%s in a query parameter schema is minor', (_name, before, after) => {
    const param = (schema: Doc): Doc => ({
      parameters: [{ name: 'q', in: 'query', schema }],
      responses: OK,
    });
    const [base, revision] = onPost(param(before), param(after));
    expect(verdict(base, revision).bump).toBe('minor');
  });

  it.each(RELAXATIONS)(
    '%s in a response body is major (direction test)',
    (_name, before, after) => {
      const [base, revision] = onPost(
        response(object({ p: before })),
        response(object({ p: after })),
      );
      expect(verdict(base, revision).bump).toBe('major');
    },
  );

  it.each(RELAXATIONS)(
    '%s in a response header is major (direction test)',
    (_name, before, after) => {
      const [base, revision] = onPost(responseHeader(before), responseHeader(after));
      expect(verdict(base, revision).bump).toBe('major');
    },
  );

  it.each(RELAXATIONS)(
    '%s in a callback payload is major (direction test)',
    (_name, before, after) => {
      const [base, revision] = onPost(callback(body(before)), callback(body(after)));
      expect(verdict(base, revision).bump).toBe('major');
    },
  );

  it.each(RELAXATIONS)(
    'the reverse of %s (a tightening) in a request is major',
    (_name, before, after) => {
      const [base, revision] = onPost(body(object({ p: after })), body(object({ p: before })));
      expect(verdict(base, revision).bump).toBe('major');
    },
  );

  it.each(['anyOf', 'oneOf', 'not'])('a relaxation under %s is major', (keyword) => {
    const wrap = (schema: Doc): Doc =>
      body(keyword === 'not' ? { not: schema } : { [keyword]: [schema, { type: 'boolean' }] });
    const [base, revision] = onPost(wrap(S({ maxLength: 5 })), wrap(S({ maxLength: 50 })));
    expect(verdict(base, revision).bump).toBe('major');
  });

  it('is major for a new enum, where there was none', () => {
    const [base, revision] = onPost(body(S()), body(S({ enum: ['a', 'b'] })));
    expect(verdict(base, revision).bump).toBe('major');
  });
});

describe('parameter-became-optional', () => {
  const param = (required: boolean | undefined): Doc => ({
    parameters: [
      { name: 'q', in: 'query', schema: S(), ...(required === undefined ? {} : { required }) },
    ],
    responses: OK,
  });

  it('is minor when required goes true → false or is removed', () => {
    let [base, revision] = onPost(param(true), param(false));
    expect(verdict(base, revision)).toEqual({
      bump: 'minor',
      rules: ['parameter-became-optional'],
    });
    [base, revision] = onPost(param(true), param(undefined));
    expect(verdict(base, revision).bump).toBe('minor');
  });

  it('is major for the reverse, and for a response header becoming optional (direction test)', () => {
    let [base, revision] = onPost(param(false), param(true));
    expect(verdict(base, revision).bump).toBe('major');
    const header = (required: boolean): Doc => ({
      responses: { '200': { description: 'ok', headers: { 'X-H': { required, schema: S() } } } },
    });
    [base, revision] = onPost(header(true), header(false));
    expect(verdict(base, revision).bump).toBe('major');
  });
});

describe('response-optional-property-added', () => {
  it('is minor for a new optional response property', () => {
    const [base, revision] = onPost(
      response(object({ a: S() })),
      response(object({ a: S(), b: S() })),
    );
    expect(verdict(base, revision)).toEqual({
      bump: 'minor',
      rules: ['response-optional-property-added'],
    });
  });

  it('is major when the response object forbade additional properties', () => {
    const closed = (props: Doc): Doc => response(object(props, { additionalProperties: false }));
    const [base, revision] = onPost(closed({ a: S() }), closed({ a: S(), b: S() }));
    expect(verdict(base, revision).bump).toBe('major');
  });

  it('is major for the same property added to a callback response (direction test)', () => {
    const [base, revision] = onPost(
      callback(response(object({ a: S() }))),
      callback(response(object({ a: S(), b: S() }))),
    );
    expect(verdict(base, revision).bump).toBe('major');
  });
});

describe('response-optional-header-added', () => {
  const headers = (h: Doc): Doc => ({ responses: { '200': { description: 'ok', headers: h } } });

  it('is minor for a new optional response header', () => {
    const [base, revision] = onPost(headers({}), headers({ 'X-New': { schema: S() } }));
    expect(verdict(base, revision)).toEqual({
      bump: 'minor',
      rules: ['response-optional-header-added'],
    });
  });

  it('is major for a new required response header, or one on a callback response', () => {
    let [base, revision] = onPost(
      headers({}),
      headers({ 'X-New': { required: true, schema: S() } }),
    );
    expect(verdict(base, revision).bump).toBe('major');
    [base, revision] = onPost(
      callback(headers({})),
      callback(headers({ 'X-New': { schema: S() } })),
    );
    expect(verdict(base, revision).bump).toBe('major');
  });
});

describe('unreferenced-schema-added', () => {
  it('is minor for a schema nothing references, major for any other component kind', () => {
    const base = doc({});
    expect(verdict(base, doc({}, { components: { schemas: { New: S() } } }))).toEqual({
      bump: 'minor',
      rules: ['unreferenced-schema-added'],
    });
    const parameter = {
      components: { parameters: { New: { name: 'q', in: 'query', schema: S() } } },
    };
    expect(verdict(base, doc({}, parameter)).bump).toBe('major');
    expect(verdict(doc({}, { components: { schemas: { Old: S() } } }), base).bump).toBe('major');
  });
});

describe('deprecated-set', () => {
  it('is minor on an operation, a parameter and a property, in either direction', () => {
    let [base, revision] = onPost({ responses: OK }, { deprecated: true, responses: OK });
    expect(verdict(base, revision)).toEqual({ bump: 'minor', rules: ['deprecated-set'] });
    const param = (extra: Doc): Doc => ({
      parameters: [{ name: 'q', in: 'query', schema: S(), ...extra }],
      responses: OK,
    });
    [base, revision] = onPost(param({}), param({ deprecated: true }));
    expect(verdict(base, revision).bump).toBe('minor');
    [base, revision] = onPost(
      body(object({ a: S() })),
      body(object({ a: S({ deprecated: true }) })),
    );
    expect(verdict(base, revision).bump).toBe('minor');
    [base, revision] = onPost(
      response(object({ a: S() })),
      response(object({ a: S({ deprecated: true }) })),
    );
    expect(verdict(base, revision).bump).toBe('minor');
  });

  it('is major when un-deprecating, on a schema root, or inside a callback', () => {
    let [base, revision] = onPost({ deprecated: true, responses: OK }, { responses: OK });
    expect(verdict(base, revision).bump).toBe('major');
    [base, revision] = onPost(body(S()), body(S({ deprecated: true })));
    expect(verdict(base, revision).bump).toBe('major');
    [base, revision] = onPost(
      callback({ responses: OK }),
      callback({ deprecated: true, responses: OK }),
    );
    expect(verdict(base, revision).bump).toBe('major');
  });
});

describe('a shared component reaching both directions', () => {
  const shared = (name: Doc): [Doc, Doc] => {
    const ref = { $ref: '#/components/schemas/Name' };
    const operation = { ...body(ref), ...response(ref) };
    return [
      doc({ '/t': { post: operation } }, { components: { schemas: { Name: name } } }),
      operation,
    ];
  };

  it('is major for a relaxation allowed on the request side but not the response side', () => {
    const [base] = shared(S({ maxLength: 5 }));
    const [revision] = shared(S({ maxLength: 50 }));
    expect(verdict(base, revision)).toEqual({
      bump: 'major',
      rules: ['request-constraint-relaxed', 'major'],
    });
  });

  it('is minor for a change allowed on both sides: a new optional property', () => {
    const [base] = shared(object({ a: S() }));
    const [revision] = shared(object({ a: S(), b: S() }));
    expect(verdict(base, revision)).toEqual({
      bump: 'minor',
      rules: ['request-optional-property-added', 'response-optional-property-added'],
    });
  });

  it('is minor for the relaxation when the component is used only in requests', () => {
    const only = (maxLength: number): Doc =>
      doc(
        { '/t': { post: body({ $ref: '#/components/schemas/Name' }) } },
        { components: { schemas: { Name: S({ maxLength }) } } },
      );
    expect(verdict(only(5), only(50)).bump).toBe('minor');
  });
});

describe('extensions and unchanged specs', () => {
  it('is patch for an extension no generator reads, major for one a generator reads', () => {
    const [base, inert] = onPost({ responses: OK }, { 'x-owner': 'a', responses: OK });
    expect(verdict(base, inert)).toEqual({ bump: 'patch', rules: ['extension'] });
    const [, sdk] = onPost({ responses: OK }, { 'x-enum-varnames': ['A'], responses: OK });
    expect(verdict(base, sdk).bump).toBe('major');
  });

  it('has no edits at all for an unchanged spec, or one changed only in annotations', () => {
    const base = doc({ '/t': { post: body(S()) } });
    expect(verdict(base, base)).toEqual({ bump: 'none', rules: [] });
    const described = doc({ '/t': { post: { ...body(S()), description: 'new' } } });
    expect(verdict(base, described)).toEqual({ bump: 'none', rules: [] });
  });
});

describe('helpers', () => {
  it.each([
    [['paths', '/t', 'get', 'parameters', 'query:q'], 'request'],
    [['paths', '/t', 'parameters', 'query:q'], 'request'],
    [['paths', '/t', 'post', 'requestBody'], 'request'],
    [['paths', '/t', 'get', 'responses', '200', 'content'], 'response'],
    [['paths', '/t', 'get', 'responses', '200', 'headers', 'X'], 'response'],
    [['paths', '/t', 'get', 'responses', '200'], 'none'],
    [['paths', '/t', 'get', 'callbacks', 'cb'], 'inverted'],
    [['webhooks', 'ping'], 'inverted'],
    [['paths', '/t', 'servers'], 'none'],
    [['servers', '0'], 'none'],
  ])('directionOf(%j) is %s', (location, expected) => {
    expect(directionOf(location)).toBe(expected);
  });

  it.each([
    [[], true],
    [['properties', 'a', 'items', 'allOf', '0', 'additionalProperties'], true],
    [['properties', 'properties'], true],
    [['properties'], false],
    [['allOf', 'x'], false],
    [['anyOf', '0'], false],
    [['not'], false],
  ])('isPlainPosition(%j) is %s', (segments, expected) => {
    expect(isPlainPosition(segments)).toBe(expected);
  });

  it('reads parameter lists by in:name', () => {
    const value = {
      paths: { '/t': { get: { parameters: [{ in: 'query', name: 'q', required: true }] } } },
    };
    expect(valueAt(value, ['paths', '/t', 'get', 'parameters', 'query:q', 'required'])).toBe(true);
    expect(valueAt(value, ['paths', '/t', 'get', 'parameters', 'query:r'])).toBeUndefined();
    expect(valueAt(value, ['paths', '/u'])).toBeUndefined();
  });

  it('recognises generator-read extensions by name and by prefix', () => {
    expect(isSdkExtension('x-enum-varnames')).toBe(true);
    expect(isSdkExtension('x-python-type')).toBe(true);
    expect(isSdkExtension('x-owner')).toBe(false);
  });
});

import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { resolveOasdiffBinary } from '../oasdiff/binary.js';
import type { OasdiffChange, ProcessRunner } from '../oasdiff/index.js';
import { OASDIFF_CLASSIFICATION_MAP_FILENAME } from '../oasdiff/version.js';
import { computeContractPlan, type ContractPlan } from '../plan.js';
import { loadClassificationMap } from './classification-map.js';
import { unchangedSurface } from '../surface/test-support.js';

// Every under-bump found in review cycles 1-5, through computeContractPlan:
// alone and beside an unrelated new optional response property, against
// stubbed oasdiff output and against the real pinned binary.

const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
const classificationMap = await loadClassificationMap(
  join(dataDir, OASDIFF_CLASSIFICATION_MAP_FILENAME),
);
const oasdiffPath = await resolveOasdiffBinary({
  cacheDir: join(homedir(), '.cache', 'speckify', 'oasdiff'),
}).catch(() => null);

type Doc = Record<string, unknown>;

const S = (extra: Doc = {}): Doc => ({ type: 'string', ...extra });
const I = (extra: Doc = {}): Doc => ({ type: 'integer', ...extra });
const A = (extra: Doc = {}): Doc => ({ type: 'array', items: S(), ...extra });
const obj = (properties: Doc, extra: Doc = {}): Doc => ({ type: 'object', properties, ...extra });
const OK = { '200': { description: 'ok' } };
const ref = (name: string): Doc => ({ $ref: `#/components/schemas/${name}` });

const idOnly = { id: S() };
const withNotes = { id: S(), notes: S() };
const jsonResponse = (properties: Doc): Doc => ({
  '200': {
    description: 'ok',
    content: { 'application/json': { schema: obj(properties) } },
  },
});

/** One side of a scenario: the POST /things operation and anything else in the document. */
interface Side {
  readonly post?: Doc;
  readonly doc?: Doc;
  readonly openapi?: string;
}

/**
 * Builds a spec. The noise, a new optional response property, goes in the
 * same operation's response unless the scenario defines that response itself.
 */
function build(side: Side, version: string, noise: boolean): Doc {
  const post = side.post ?? {};
  const noiseInPost = !('responses' in post);
  const extraPaths = (side.doc?.paths ?? {}) as Doc;
  return {
    openapi: side.openapi ?? '3.0.3',
    info: { title: 'Things', version },
    ...side.doc,
    paths: {
      '/things': {
        post: {
          operationId: 'createThing',
          responses: jsonResponse(noise && noiseInPost ? withNotes : idOnly),
          ...post,
        },
        get: {
          operationId: 'listThings',
          responses: jsonResponse(noise && !noiseInPost ? withNotes : idOnly),
        },
      },
      ...extraPaths,
    },
  };
}

const body = (schema: Doc): Doc => ({
  requestBody: { content: { 'application/json': { schema } } },
});
const queryParam = (schema: Doc, extra: Doc = {}): Doc => ({
  parameters: [{ name: 'tags', in: 'query', schema, ...extra }],
});
const deepObject = (maxLength: number): Doc => ({
  parameters: [
    {
      name: 'filter',
      in: 'query',
      style: 'deepObject',
      explode: true,
      schema: obj({ name: S({ maxLength }) }),
    },
  ],
});
const callbackOperation = (payload: Doc): Doc => ({
  callbacks: {
    done: {
      '{$request.body#/url}': {
        post: {
          requestBody: { content: { 'application/json': { schema: payload } } },
          responses: OK,
        },
      },
    },
  },
});
const payload = (status: Doc, name: Doc, required: string[]): Doc => ({
  type: 'object',
  required,
  properties: { status, name },
});
const contact = obj({ email: S(), phone: S() });
const withComponents = (post: Doc, schemas: Doc, openapi?: string): Side => ({
  post,
  doc: { components: { schemas } },
  ...(openapi === undefined ? {} : { openapi }),
});
const schemes = {
  key: {
    type: 'oauth2',
    flows: {
      clientCredentials: { tokenUrl: 'https://a.example/t', scopes: { read: 'r', write: 'w' } },
    },
  },
};
const pets = (discriminator: Doc): Doc =>
  body({
    oneOf: [ref('Cat'), ref('Dog')],
    discriminator,
  });
const petSchemas = {
  Cat: obj({ kind: S(), meow: S() }),
  Dog: obj({ kind: S(), bark: S() }),
};
const responseHeaders = (headers: Doc): Doc => ({
  responses: { '200': { description: 'ok', headers } },
});
const responseInteger = (schema: Doc): Doc => ({
  responses: {
    '200': { description: 'ok', content: { 'application/json': { schema: obj({ n: schema }) } } },
  },
});
const body31 = (before: Doc, after: Doc): [Side, Side] => [
  { post: body(before), openapi: '3.1.0' },
  { post: body(after), openapi: '3.1.0' },
];

/** Every under-bump scenario from review cycles 1-5, as [base, revision]. */
const SCENARIOS: Readonly<Record<string, readonly [Side, Side]>> = {
  // Cycle 1.
  'request additionalProperties tightened true -> false': [
    { post: body({ type: 'object', additionalProperties: true }) },
    { post: body({ type: 'object', additionalProperties: false }) },
  ],
  'servers url changed': [
    { doc: { servers: [{ url: 'https://api.example.com/v1' }] } },
    { doc: { servers: [{ url: 'https://api.example.com/v2' }] } },
  ],
  // Cycle 2.
  'additionalProperties tightened inside a request property named title': [
    { post: body(obj({ title: { type: 'object', additionalProperties: true } })) },
    { post: body(obj({ title: { type: 'object', additionalProperties: false } })) },
  ],
  // Cycle 3.
  'array query param items.maxLength 50 -> 5': [
    { post: queryParam(A({ items: S({ maxLength: 50 }) })) },
    { post: queryParam(A({ items: S({ maxLength: 5 }) })) },
  ],
  'array query param items gains enum [a, b]': [
    { post: queryParam(A()) },
    { post: queryParam(A({ items: S({ enum: ['a', 'b'] }) })) },
  ],
  'deepObject param properties.name.maxLength 50 -> 5': [
    { post: deepObject(50) },
    { post: deepObject(5) },
  ],
  'callback payload status enum gains a value': [
    { post: callbackOperation(payload(S({ enum: ['a'] }), S({ maxLength: 5 }), ['status'])) },
    { post: callbackOperation(payload(S({ enum: ['a', 'b'] }), S({ maxLength: 5 }), ['status'])) },
  ],
  'callback payload maxLength relaxed': [
    { post: callbackOperation(payload(S({ enum: ['a'] }), S({ maxLength: 5 }), ['status'])) },
    { post: callbackOperation(payload(S({ enum: ['a'] }), S({ maxLength: 50 }), ['status'])) },
  ],
  'callback payload required dropped': [
    { post: callbackOperation(payload(S({ enum: ['a'] }), S({ maxLength: 5 }), ['status'])) },
    { post: callbackOperation(payload(S({ enum: ['a'] }), S({ maxLength: 5 }), [])) },
  ],
  'callback removed entirely': [
    { post: callbackOperation(payload(S({ enum: ['a'] }), S({ maxLength: 5 }), ['status'])) },
    { post: {} },
  ],
  // Cycle 5: the checks that held.
  '$ref chain A -> B -> C tightened in a request': [
    withComponents(body(ref('A')), {
      A: obj({ b: ref('B') }),
      B: obj({ c: ref('C') }),
      C: S({ maxLength: 50 }),
    }),
    withComponents(body(ref('A')), {
      A: obj({ b: ref('B') }),
      B: obj({ c: ref('C') }),
      C: S({ maxLength: 5 }),
    }),
  ],
  'shared component relaxed where used in a request and a response': [
    withComponents(
      {
        ...body(ref('Name')),
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: ref('Name') } } },
        },
      },
      { Name: S({ maxLength: 5 }) },
    ),
    withComponents(
      {
        ...body(ref('Name')),
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: ref('Name') } } },
        },
      },
      { Name: S({ maxLength: 50 }) },
    ),
  ],
  '$ref retargeted to a looser same-shape component': [
    withComponents(body(ref('Strict')), {
      Strict: S({ maxLength: 5 }),
      Loose: S({ maxLength: 50 }),
    }),
    withComponents(body(ref('Loose')), {
      Strict: S({ maxLength: 5 }),
      Loose: S({ maxLength: 50 }),
    }),
  ],
  'recursive component tightened': [
    withComponents(body(ref('Node')), {
      Node: obj({ name: S({ maxLength: 50 }), child: ref('Node') }),
    }),
    withComponents(body(ref('Node')), {
      Node: obj({ name: S({ maxLength: 5 }), child: ref('Node') }),
    }),
  ],
  '3.1 sibling maxLength next to a $ref tightened': [
    withComponents(
      body({ $ref: '#/components/schemas/Name', maxLength: 50 }),
      { Name: S() },
      '3.1.0',
    ),
    withComponents(
      body({ $ref: '#/components/schemas/Name', maxLength: 5 }),
      { Name: S() },
      '3.1.0',
    ),
  ],
  'explode false -> absent on a form query parameter': [
    { post: queryParam(A(), { explode: false }) },
    { post: queryParam(A()) },
  ],
  'multipart encoding contentType changed': [
    {
      post: {
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: obj({ p: S() }),
              encoding: { p: { contentType: 'a/b' } },
            },
          },
        },
      },
    },
    {
      post: {
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: obj({ p: S() }),
              encoding: { p: { contentType: 'c/d' } },
            },
          },
        },
      },
    },
  ],
  'security scope added globally': [
    { doc: { components: { securitySchemes: schemes }, security: [{ key: ['read'] }] } },
    { doc: { components: { securitySchemes: schemes }, security: [{ key: ['read', 'write'] }] } },
  ],
  'security scope added on an operation': [
    { post: { security: [{ key: ['read'] }] }, doc: { components: { securitySchemes: schemes } } },
    {
      post: { security: [{ key: ['read', 'write'] }] },
      doc: { components: { securitySchemes: schemes } },
    },
  ],
  'unreferenced schema removed': [
    { doc: { components: { schemas: { Gone: S() } } } },
    { doc: { components: { schemas: {} } } },
  ],
  'webhook method removed': [
    {
      openapi: '3.1.0',
      doc: { webhooks: { ping: { post: { responses: OK }, put: { responses: OK } } } },
    },
    { openapi: '3.1.0', doc: { webhooks: { ping: { post: { responses: OK } } } } },
  ],
  'required response header removed': [
    { post: responseHeaders({ 'X-Rate': { required: true, schema: I() } }) },
    { post: responseHeaders({}) },
  ],
  'discriminator mapping retargeted': [
    withComponents(
      pets({ propertyName: 'kind', mapping: { cat: '#/components/schemas/Cat' } }),
      petSchemas,
    ),
    withComponents(
      pets({ propertyName: 'kind', mapping: { cat: '#/components/schemas/Dog' } }),
      petSchemas,
    ),
  ],
  'discriminator mapping removed': [
    withComponents(
      pets({ propertyName: 'kind', mapping: { cat: '#/components/schemas/Cat' } }),
      petSchemas,
    ),
    withComponents(pets({ propertyName: 'kind' }), petSchemas),
  ],
  'discriminator propertyName changed': [
    withComponents(pets({ propertyName: 'kind' }), petSchemas),
    withComponents(pets({ propertyName: 'type' }), petSchemas),
  ],
  '3.0 boolean exclusiveMinimum unset in a response': [
    { post: responseInteger(I({ minimum: 1, exclusiveMinimum: true })) },
    { post: responseInteger(I({ minimum: 1 })) },
  ],
  '3.0 boolean exclusiveMaximum unset in a response': [
    { post: responseInteger(I({ maximum: 9, exclusiveMaximum: true })) },
    { post: responseInteger(I({ maximum: 9 })) },
  ],
  'dependentRequired gains a member on an existing key': body31(
    obj({ a: S(), b: S(), c: S() }, { dependentRequired: { a: ['b'] } }),
    obj({ a: S(), b: S(), c: S() }, { dependentRequired: { a: ['b', 'c'] } }),
  ),
  'minContains set': body31(A({ contains: S() }), A({ contains: S(), minContains: 2 })),
  'maxContains lowered': body31(
    A({ contains: S(), maxContains: 5 }),
    A({ contains: S(), maxContains: 2 }),
  ),
  'contentMediaType set': body31(S(), S({ contentMediaType: 'application/json' })),
  'contentEncoding set': body31(S(), S({ contentEncoding: 'base64' })),
  'const set': body31(S(), S({ const: 'a' })),
  'default changed': body31(S({ default: 'a' }), S({ default: 'b' })),
  'uniqueItems unset': body31(A({ uniqueItems: true }), A()),
  'minProperties raised': body31(
    obj({ a: S() }, { minProperties: 0 }),
    obj({ a: S() }, { minProperties: 1 }),
  ),
  'maxProperties lowered': body31(
    obj({ a: S() }, { maxProperties: 5 }),
    obj({ a: S() }, { maxProperties: 1 }),
  ),
  // Cycle 5: the blockers.
  'request body gains anyOf': [
    { post: body(contact) },
    { post: body({ ...contact, anyOf: [{ required: ['email'] }, { required: ['phone'] }] }) },
  ],
  'request body gains oneOf': [
    { post: body(contact) },
    { post: body({ ...contact, oneOf: [{ required: ['email'] }, { required: ['phone'] }] }) },
  ],
  'request property gains anyOf': [
    { post: body(obj({ contact })) },
    {
      post: body(
        obj({ contact: { ...contact, anyOf: [{ required: ['email'] }, { required: ['phone'] }] } }),
      ),
    },
  ],
  'overlapping oneOf branch appended to a request body': [
    { post: body({ oneOf: [S({ maxLength: 5 }), I()] }) },
    { post: body({ oneOf: [S({ maxLength: 5 }), I(), S({ minLength: 3 })] }) },
  ],
  'allOf branch with if/then added to a request body': body31(contact, {
    ...contact,
    allOf: [{ if: { required: ['email'] }, then: { required: ['phone'] } }],
  }),
  'allOf branch with not added to a request body': [
    { post: body(contact) },
    { post: body({ ...contact, allOf: [{ not: { required: ['phone'] } }] }) },
  ],
  'allOf branch with not added to a request property': [
    { post: body(obj({ kind: S() })) },
    { post: body(obj({ kind: { ...S(), allOf: [{ not: { enum: ['x'] } }] } })) },
  ],
  'allOf branch with pattern added to a root string request body': [
    { post: body(S()) },
    { post: body({ ...S(), allOf: [{ pattern: '^a' }] }) },
  ],
  // The sabotage target: a new member in a request's required list.
  'request required gains a member': [
    { post: body(obj({ a: S(), b: S() }, { required: ['a'] })) },
    { post: body(obj({ a: S(), b: S() }, { required: ['a', 'b'] })) },
  ],
};

const noiseChange: OasdiffChange = {
  id: 'response-optional-property-added',
  text: 'added the optional property `notes`',
  level: 1,
  operation: 'POST',
  path: '/things',
};

function stub(changes: OasdiffChange[]): ProcessRunner {
  return vi.fn(async () => Promise.resolve({ stdout: JSON.stringify(changes), stderr: '' }));
}

async function plan(base: Doc, revision: Doc, runProcess?: ProcessRunner): Promise<ContractPlan> {
  return computeContractPlan({
    contract: 'things',
    bundledSpec: JSON.stringify(revision),
    previous: { version: '1.2.3', bundledSpec: JSON.stringify(base), speckifyVersion: null },
    classificationMap,
    toolchainImpactBump: 'none',
    surfaceDiff: unchangedSurface,
    oasdiffPath: runProcess === undefined ? String(oasdiffPath) : '/bin/oasdiff',
    runProcess,
  });
}

const summary = (result: ContractPlan): string => `${result.bump} ${result.version}`;

describe('every review-cycle scenario is major, against stubbed oasdiff output', () => {
  it.each(Object.entries(SCENARIOS))('%s', async (_name, [before, after]) => {
    const base = build(before, '1.2.3', false);
    // Alone, with oasdiff reporting nothing at all.
    expect(summary(await plan(base, build(after, '0.0.0', false), stub([])))).toBe('major 2.0.0');
    // Beside the noise, with oasdiff reporting only the noise as minor.
    const noisy = build(after, '0.0.0', true);
    expect(summary(await plan(base, noisy, stub([noiseChange])))).toBe('major 2.0.0');
  });

  it('the noise alone is minor, a description is patch, and no change is none', async () => {
    const base = build({}, '1.2.3', false);
    expect(summary(await plan(base, build({}, '0.0.0', true), stub([noiseChange])))).toBe(
      'minor 1.3.0',
    );
    const described = build({ post: { description: 'Creates a thing.' } }, '0.0.0', false);
    expect(summary(await plan(base, described, stub([])))).toBe('patch 1.2.4');
    expect(summary(await plan(base, build({}, '0.0.0', false), stub([])))).toBe('none 1.2.3');
  });

  it('a schema title edit is major (it can rename a generated class); info.title stays patch', async () => {
    const titled = (title: string): Side => ({ post: body(obj({ a: S() }, { title })) });
    const base = build(titled('Thing'), '1.2.3', false);
    expect(summary(await plan(base, build(titled('Widget'), '0.0.0', false), stub([])))).toBe(
      'major 2.0.0',
    );
    const renamedApi = {
      ...build(titled('Thing'), '0.0.0', false),
      info: { title: 'Widgets', version: '0.0.0' },
    };
    expect(summary(await plan(base, renamedApi, stub([])))).toBe('patch 1.2.4');
  });
});

/** One scenario per allow-list rule, each expected minor on its own. */
const ALLOWED: Readonly<Record<string, readonly [Side, Side]>> = {
  'operation-added': [
    {},
    { doc: { paths: { '/health': { get: { operationId: 'health', responses: OK } } } } },
  ],
  'optional-parameter-added': [{}, { post: queryParam(S()) }],
  'request-optional-property-added': [
    { post: body(obj({ a: S() })) },
    { post: body(obj({ a: S(), b: S() })) },
  ],
  'request-constraint-relaxed': [
    { post: body(obj({ a: S({ maxLength: 5 }) })) },
    { post: body(obj({ a: S({ maxLength: 50 }) })) },
  ],
  'parameter-became-optional': [
    { post: queryParam(S(), { required: true }) },
    { post: queryParam(S()) },
  ],
  'response-optional-property-added': [{}, { post: { responses: jsonResponse(withNotes) } }],
  'response-optional-header-added': [
    { post: responseHeaders({}) },
    { post: responseHeaders({ 'X-New': { schema: S() } }) },
  ],
  'unreferenced-schema-added': [{}, { doc: { components: { schemas: { Spare: S() } } } }],
  'deprecated-set': [{}, { post: { deprecated: true } }],
};

describe('every allow-list rule is minor through the plan', () => {
  it.each(Object.entries(ALLOWED))('%s', async (rule, [before, after]) => {
    const result = await plan(
      build(before, '1.2.3', false),
      build(after, '0.0.0', false),
      stub([]),
    );
    expect(summary(result)).toBe('minor 1.3.0');
    expect(result.judgements.map((j) => j.rule)).toEqual([rule]);
  });
});

describe.skipIf(oasdiffPath === null)('the same scenarios against the real oasdiff binary', () => {
  it.each(Object.entries(SCENARIOS))('%s', async (_name, [before, after]) => {
    const base = build(before, '1.2.3', false);
    expect(summary(await plan(base, build(after, '0.0.0', false)))).toBe('major 2.0.0');
    expect(summary(await plan(base, build(after, '0.0.0', true)))).toBe('major 2.0.0');
  });

  it('the controls hold: noise minor, description patch, unchanged none', async () => {
    const base = build({}, '1.2.3', false);
    expect(summary(await plan(base, build({}, '0.0.0', true)))).toBe('minor 1.3.0');
    const described = build({ post: { description: 'Creates a thing.' } }, '0.0.0', false);
    expect(summary(await plan(base, described))).toBe('patch 1.2.4');
    expect(summary(await plan(base, build({}, '0.0.0', false)))).toBe('none 1.2.3');
  });

  it("takes oasdiff's major over the allow-list's minor: a deprecation with an unparseable sunset", async () => {
    const base = build({}, '1.2.3', false);
    const revision = build(
      { post: { deprecated: true, 'x-sunset': 'not-a-date' } },
      '0.0.0',
      false,
    );
    const result = await plan(base, revision);
    expect(result.judgements.map((j) => j.bump).sort()).toEqual(['minor', 'patch']);
    expect(result.changes.map((c) => c.id)).toContain('api-deprecated-sunset-parse');
    expect(summary(result)).toBe('major 2.0.0');
  });
});

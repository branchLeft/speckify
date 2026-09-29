import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { resolveOasdiffBinary } from '../oasdiff/binary.js';
import { runOasdiffChangelog, type OasdiffChange } from '../oasdiff/index.js';
import {
  OASDIFF_CLASSIFICATION_MAP_FILENAME,
  OASDIFF_LOCATION_CLAIMS_FILENAME,
  OASDIFF_SILENT_CLAIMS_FILENAME,
} from '../oasdiff/version.js';
import { computeContractPlan } from '../plan.js';
import { loadClassificationMap } from './classification-map.js';
import {
  findUncoveredEdits,
  loadOasdiffCoverage,
  type OasdiffCoverage,
} from './location-coverage.js';
import { diffDocuments, prepareDocument } from './structural-diff.js';
import type { ClassificationMap } from './types.js';

// The empirical validation of location-coverage.md §7: every fixture Speckify
// calls covered must be one the real, pinned oasdiff binary reports on.
const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
const oasdiffPath = await resolveOasdiffBinary({
  cacheDir: join(homedir(), '.cache', 'speckify', 'oasdiff'),
}).catch(() => null);

type Doc = Record<string, unknown>;
type Schema = Doc;

interface Fixture {
  readonly name: string;
  readonly base: Doc;
  readonly revision: Doc;
}

const S = (extra: Doc = {}): Schema => ({ type: 'string', ...extra });
const I = (extra: Doc = {}): Schema => ({ type: 'integer', ...extra });
const A = (extra: Doc = {}): Schema => ({ type: 'array', items: S(), ...extra });
const O = (extra: Doc = {}): Schema => ({ type: 'object', properties: { p: S() }, ...extra });

/** Schema changes valid in OpenAPI 3.0 and 3.1: [before, after]. */
const CHANGES: Readonly<Record<string, readonly [Schema, Schema]>> = {
  maxLengthDecrease: [S({ maxLength: 50 }), S({ maxLength: 5 })],
  maxLengthIncrease: [S({ maxLength: 5 }), S({ maxLength: 50 })],
  maxLengthSet: [S(), S({ maxLength: 5 })],
  maxLengthUnset: [S({ maxLength: 5 }), S()],
  minLengthIncrease: [S({ minLength: 1 }), S({ minLength: 5 })],
  minLengthDecrease: [S({ minLength: 5 }), S({ minLength: 1 })],
  minLengthSet: [S(), S({ minLength: 5 })],
  minLengthUnset: [S({ minLength: 5 }), S()],
  enumAdd: [S({ enum: ['a'] }), S({ enum: ['a', 'b'] })],
  enumRemove: [S({ enum: ['a', 'b'] }), S({ enum: ['a'] })],
  enumIntroduced: [S(), S({ enum: ['a', 'b'] })],
  enumDropped: [S({ enum: ['a', 'b'] }), S()],
  patternSet: [S(), S({ pattern: '^a' })],
  patternChange: [S({ pattern: '^a' }), S({ pattern: '^b' })],
  patternUnset: [S({ pattern: '^a' }), S()],
  formatSet: [S(), S({ format: 'uuid' })],
  formatChange: [S({ format: 'uuid' }), S({ format: 'email' })],
  formatUnset: [S({ format: 'uuid' }), S()],
  extensionAdd: [S(), S({ 'x-foo': 1 })],
  extensionChange: [S({ 'x-foo': 1 }), S({ 'x-foo': 2 })],
  extensionRemove: [S({ 'x-foo': 1 }), S()],
  defaultSet: [S(), S({ default: 'b' })],
  defaultChange: [S({ default: 'a' }), S({ default: 'b' })],
  defaultUnset: [S({ default: 'a' }), S()],
  minimumIncrease: [I({ minimum: 1 }), I({ minimum: 5 })],
  minimumDecrease: [I({ minimum: 5 }), I({ minimum: 1 })],
  minimumSet: [I(), I({ minimum: 5 })],
  minimumUnset: [I({ minimum: 5 }), I()],
  maximumDecrease: [I({ maximum: 50 }), I({ maximum: 5 })],
  maximumIncrease: [I({ maximum: 5 }), I({ maximum: 50 })],
  maximumSet: [I(), I({ maximum: 5 })],
  maximumUnset: [I({ maximum: 5 }), I()],
  multipleOfIncrease: [I({ multipleOf: 2 }), I({ multipleOf: 4 })],
  multipleOfDecrease: [I({ multipleOf: 4 }), I({ multipleOf: 2 })],
  multipleOfSet: [I(), I({ multipleOf: 4 })],
  multipleOfUnset: [I({ multipleOf: 4 }), I()],
  maxItemsDecrease: [A({ maxItems: 5 }), A({ maxItems: 2 })],
  maxItemsIncrease: [A({ maxItems: 2 }), A({ maxItems: 5 })],
  maxItemsSet: [A(), A({ maxItems: 2 })],
  maxItemsUnset: [A({ maxItems: 2 }), A()],
  minItemsIncrease: [A({ minItems: 1 }), A({ minItems: 2 })],
  minItemsDecrease: [A({ minItems: 2 }), A({ minItems: 1 })],
  minItemsSet: [A(), A({ minItems: 2 })],
  minItemsUnset: [A({ minItems: 2 }), A()],
  uniqueItemsSet: [A(), A({ uniqueItems: true })],
  uniqueItemsUnset: [A({ uniqueItems: true }), A()],
  maxPropertiesDecrease: [O({ maxProperties: 5 }), O({ maxProperties: 2 })],
  maxPropertiesSet: [O(), O({ maxProperties: 2 })],
  minPropertiesIncrease: [O({ minProperties: 1 }), O({ minProperties: 2 })],
  minPropertiesUnset: [O({ minProperties: 1 }), O()],
  requiredAdd: [O(), O({ required: ['p'] })],
  requiredRemove: [O({ required: ['p'] }), O()],
  propertyAdd: [O(), O({ properties: { p: S(), q: S() } })],
  propertyRemove: [O({ properties: { p: S(), q: S() } }), O()],
  additionalPropertiesFalse: [O(), O({ additionalProperties: false })],
  additionalPropertiesTightened: [
    O({ additionalProperties: S() }),
    O({ additionalProperties: S({ maxLength: 1 }) }),
  ],
  readOnlySet: [S(), S({ readOnly: true })],
  readOnlyUnset: [S({ readOnly: true }), S()],
  writeOnlySet: [S(), S({ writeOnly: true })],
  writeOnlyUnset: [S({ writeOnly: true }), S()],
  deprecatedSet: [S(), S({ deprecated: true })],
  deprecatedUnset: [S({ deprecated: true }), S()],
  typeChange: [S(), I()],
  discriminatorSet: [
    O({ properties: { k: S() } }),
    O({ properties: { k: S() }, discriminator: { propertyName: 'k' } }),
  ],
  discriminatorUnset: [
    O({ properties: { k: S() }, discriminator: { propertyName: 'k' } }),
    O({ properties: { k: S() } }),
  ],
  oneOfBranchAdded: [{ oneOf: [S(), I()] }, { oneOf: [S(), I(), { type: 'boolean' }] }],
  anyOfBranchRemoved: [{ anyOf: [S(), I()] }, { anyOf: [S()] }],
  itemsTypeChange: [A(), A({ items: I() })],
  notIntroduced: [S(), S({ not: S({ maxLength: 1 }) })],
};

/** Schema changes only OpenAPI 3.0 can express. */
const CHANGES_3_0: Readonly<Record<string, readonly [Schema, Schema]>> = {
  nullableSet: [S(), S({ nullable: true })],
  nullableUnset: [S({ nullable: true }), S()],
  exclusiveMinimumSet: [I({ minimum: 1 }), I({ minimum: 1, exclusiveMinimum: true })],
  exclusiveMinimumUnset: [I({ minimum: 1, exclusiveMinimum: true }), I({ minimum: 1 })],
  exclusiveMaximumSet: [I({ maximum: 1 }), I({ maximum: 1, exclusiveMaximum: true })],
};

/** Schema changes only OpenAPI 3.1 can express. */
const CHANGES_3_1: Readonly<Record<string, readonly [Schema, Schema]>> = {
  constSet: [S(), S({ const: 'a' })],
  constChange: [S({ const: 'a' }), S({ const: 'b' })],
  constUnset: [S({ const: 'a' }), S()],
  nullTypeAdded: [S(), { type: ['string', 'null'] }],
  nullTypeRemoved: [{ type: ['string', 'null'] }, S()],
  exclusiveMinimumIncrease: [I({ exclusiveMinimum: 1 }), I({ exclusiveMinimum: 5 })],
  exclusiveMinimumSet: [I(), I({ exclusiveMinimum: 5 })],
  exclusiveMaximumDecrease: [I({ exclusiveMaximum: 9 }), I({ exclusiveMaximum: 5 })],
  exclusiveMaximumUnset: [I({ exclusiveMaximum: 9 }), I()],
  prefixItemsAdded: [A({ prefixItems: [S()] }), A({ prefixItems: [S(), I()] })],
  containsSet: [A(), A({ contains: S({ const: 'a' }) })],
  minContainsSet: [A({ contains: S() }), A({ contains: S(), minContains: 2 })],
  maxContainsDecrease: [A({ contains: S(), maxContains: 5 }), A({ contains: S(), maxContains: 2 })],
  propertyNamesSet: [O(), O({ propertyNames: S({ maxLength: 3 }) })],
  dependentRequiredAdded: [O(), O({ dependentRequired: { p: ['q'] } })],
  unevaluatedPropertiesSet: [O(), O({ unevaluatedProperties: false })],
  ifSet: [O(), O({ if: O({ required: ['p'] }), then: O({ required: ['q'] }) })],
};

/** Where in an operation a schema is placed. */
const PLACEMENTS: Readonly<Record<string, (schema: Schema) => Doc>> = {
  requestBody: (schema) => ({
    requestBody: { content: { 'application/json': { schema } } },
    responses: { '200': { description: 'ok' } },
  }),
  response: (schema) => ({
    responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
  }),
  queryParameter: (schema) => ({
    parameters: [{ name: 'q', in: 'query', schema }],
    responses: { '200': { description: 'ok' } },
  }),
  deepObjectParameter: (schema) => ({
    parameters: [{ name: 'f', in: 'query', style: 'deepObject', explode: true, schema }],
    responses: { '200': { description: 'ok' } },
  }),
  headerParameter: (schema) => ({
    parameters: [{ name: 'X-Q', in: 'header', schema }],
    responses: { '200': { description: 'ok' } },
  }),
  pathParameter: (schema) => ({
    parameters: [{ name: 'id', in: 'path', required: true, schema }],
    responses: { '200': { description: 'ok' } },
  }),
  cookieParameter: (schema) => ({
    parameters: [{ name: 'c', in: 'cookie', schema }],
    responses: { '200': { description: 'ok' } },
  }),
  responseHeader: (schema) => ({
    responses: { '200': { description: 'ok', headers: { 'X-H': { schema } } } },
  }),
  callbackBody: (schema) => ({
    callbacks: {
      done: {
        '{$request.body#/url}': {
          post: {
            requestBody: { content: { 'application/json': { schema } } },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    },
    responses: { '200': { description: 'ok' } },
  }),
};

/** How deep inside the placed schema the change sits. */
const NESTINGS: Readonly<Record<string, (schema: Schema) => Schema>> = {
  top: (s) => s,
  property: (s) => ({ type: 'object', properties: { a: s } }),
  propertyOfProperty: (s) => ({
    type: 'object',
    properties: { a: { type: 'object', properties: { b: s } } },
  }),
  items: (s) => ({ type: 'array', items: s }),
  itemsProperty: (s) => ({ type: 'array', items: { type: 'object', properties: { a: s } } }),
  additionalProperties: (s) => ({ type: 'object', additionalProperties: s }),
  anyOf: (s) => ({ anyOf: [s, { type: 'boolean' }] }),
  oneOf: (s) => ({ oneOf: [s, { type: 'boolean' }] }),
  allOf: (s) => ({ allOf: [s] }),
  allOfProperty: (s) => ({ allOf: [{ type: 'object', properties: { a: s } }] }),
  propertyAllOf: (s) => ({ type: 'object', properties: { a: { allOf: [s] } } }),
  allOfItems: (s) => ({ allOf: [{ type: 'array', items: s }] }),
  itemsAllOf: (s) => ({ type: 'array', items: { allOf: [s] } }),
  not: (s) => ({ not: s }),
};

function spec(openapi: string, paths: Doc, extra: Doc = {}): Doc {
  return { openapi, info: { title: 'Fixtures', version: '1.0.0' }, paths, ...extra };
}

/** Every placement × nesting × change, each on its own path. */
function schemaMatrix(
  openapi: string,
  changes: Record<string, readonly [Schema, Schema]>,
): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const [placement, place] of Object.entries(PLACEMENTS)) {
    for (const [nesting, nest] of Object.entries(NESTINGS)) {
      for (const [change, [before, after]] of Object.entries(changes)) {
        const path = `/${placement}/${nesting}/${change}${placement === 'pathParameter' ? '/{id}' : ''}`;
        fixtures.push({
          name: path,
          base: spec(openapi, { [path]: { post: place(nest(before)) } }),
          revision: spec(openapi, { [path]: { post: place(nest(after)) } }),
        });
      }
    }
  }
  return fixtures;
}

const PARAM = { name: 'q', in: 'query', schema: S() };
const OK = { '200': { description: 'ok' } };

/** Operation-level changes: [before operation, after operation]. */
const OPERATION_CHANGES: Readonly<Record<string, readonly [Doc, Doc]>> = {
  parameterAdded: [{ responses: OK }, { parameters: [PARAM], responses: OK }],
  requiredParameterAdded: [
    { responses: OK },
    { parameters: [{ ...PARAM, required: true }], responses: OK },
  ],
  parameterRemoved: [{ parameters: [PARAM], responses: OK }, { responses: OK }],
  parameterBecameRequired: [
    { parameters: [PARAM], responses: OK },
    { parameters: [{ ...PARAM, required: true }], responses: OK },
  ],
  parameterBecameOptional: [
    { parameters: [{ ...PARAM, required: true }], responses: OK },
    { parameters: [PARAM], responses: OK },
  ],
  parameterDeprecated: [
    { parameters: [PARAM], responses: OK },
    { parameters: [{ ...PARAM, deprecated: true }], responses: OK },
  ],
  parameterStyleChanged: [
    { parameters: [{ ...PARAM, schema: A() }], responses: OK },
    { parameters: [{ ...PARAM, schema: A(), style: 'pipeDelimited' }], responses: OK },
  ],
  parameterExtensionChanged: [
    { parameters: [{ ...PARAM, 'x-a': 1 }], responses: OK },
    { parameters: [{ ...PARAM, 'x-a': 2 }], responses: OK },
  ],
  operationDeprecated: [{ responses: OK }, { deprecated: true, responses: OK }],
  operationIdChanged: [
    { operationId: 'a', responses: OK },
    { operationId: 'b', responses: OK },
  ],
  operationTagAdded: [
    { tags: ['a'], responses: OK },
    { tags: ['a', 'b'], responses: OK },
  ],
  operationExtensionChanged: [
    { 'x-a': 1, responses: OK },
    { 'x-a': 2, responses: OK },
  ],
  operationServersChanged: [
    { servers: [{ url: 'https://a.example' }], responses: OK },
    { servers: [{ url: 'https://b.example' }], responses: OK },
  ],
  operationSecurityAdded: [{ responses: OK }, { security: [{ key: [] }], responses: OK }],
  operationSecurityRemoved: [{ security: [{ key: [] }], responses: OK }, { responses: OK }],
  requestBodyAdded: [
    { responses: OK },
    { requestBody: { content: { 'application/json': { schema: S() } } }, responses: OK },
  ],
  requestBodyBecameRequired: [
    { requestBody: { content: { 'application/json': { schema: S() } } }, responses: OK },
    {
      requestBody: { required: true, content: { 'application/json': { schema: S() } } },
      responses: OK,
    },
  ],
  requestMediaTypeAdded: [
    { requestBody: { content: { 'application/json': { schema: S() } } }, responses: OK },
    {
      requestBody: {
        content: { 'application/json': { schema: S() }, 'text/plain': { schema: S() } },
      },
      responses: OK,
    },
  ],
  responseAdded: [{ responses: OK }, { responses: { ...OK, '404': { description: 'missing' } } }],
  responseRemoved: [{ responses: { ...OK, '404': { description: 'missing' } } }, { responses: OK }],
  responseHeaderAdded: [
    { responses: OK },
    { responses: { '200': { description: 'ok', headers: { 'X-A': { schema: S() } } } } },
  ],
  responseHeaderBecameOptional: [
    {
      responses: {
        '200': { description: 'ok', headers: { 'X-A': { required: true, schema: S() } } },
      },
    },
    { responses: { '200': { description: 'ok', headers: { 'X-A': { schema: S() } } } } },
  ],
  responseHeaderBecameRequired: [
    { responses: { '200': { description: 'ok', headers: { 'X-A': { schema: S() } } } } },
    {
      responses: {
        '200': { description: 'ok', headers: { 'X-A': { required: true, schema: S() } } },
      },
    },
  ],
  callbackRemoved: [
    {
      callbacks: {
        done: { '{$request.body#/url}': { post: { responses: OK } } },
      },
      responses: OK,
    },
    { responses: OK },
  ],
  encodingChanged: [
    {
      requestBody: {
        content: {
          'multipart/form-data': { schema: O(), encoding: { p: { contentType: 'a/b' } } },
        },
      },
      responses: OK,
    },
    {
      requestBody: {
        content: {
          'multipart/form-data': { schema: O(), encoding: { p: { contentType: 'c/d' } } },
        },
      },
      responses: OK,
    },
  ],
};

function operationMatrix(): Fixture[] {
  return Object.entries(OPERATION_CHANGES).map(([change, [before, after]]) => {
    const path = `/operation/${change}`;
    return {
      name: path,
      base: spec('3.0.3', { [path]: { post: before } }),
      revision: spec('3.0.3', { [path]: { post: after } }),
    };
  });
}

const SCHEMES = { key: { type: 'apiKey', in: 'header', name: 'X-Key' } };
const oauth = (scopes: Doc, tokenUrl = 'https://a.example/token'): Doc => ({
  type: 'oauth2',
  flows: { clientCredentials: { tokenUrl, scopes } },
});

const implicit = (authorizationUrl: string): Doc => ({
  type: 'oauth2',
  flows: { implicit: { authorizationUrl, scopes: { read: 'r' } } },
});

/** Changes outside any operation: each its own oasdiff run. */
const DOCUMENT_CHANGES: Readonly<Record<string, readonly [Doc, Doc]>> = {
  pathAdded: [{ paths: {} }, { paths: { '/a': { get: { responses: OK } } } }],
  pathRemoved: [{ paths: { '/a': { get: { responses: OK } } } }, { paths: {} }],
  operationAdded: [
    { paths: { '/a': { get: { responses: OK } } } },
    { paths: { '/a': { get: { responses: OK }, post: { responses: OK } } } },
  ],
  pathLevelParameterAdded: [
    { paths: { '/a': { get: { responses: OK } } } },
    { paths: { '/a': { parameters: [PARAM], get: { responses: OK } } } },
  ],
  pathLevelParameterTightened: [
    { paths: { '/a': { parameters: [PARAM], get: { responses: OK } } } },
    {
      paths: {
        '/a': { parameters: [{ ...PARAM, schema: S({ maxLength: 3 }) }], get: { responses: OK } },
      },
    },
  ],
  globalSecurityAdded: [
    { components: { securitySchemes: SCHEMES } },
    { components: { securitySchemes: SCHEMES }, security: [{ key: [] }] },
  ],
  securitySchemeAdded: [{}, { components: { securitySchemes: SCHEMES } }],
  securitySchemeRemoved: [{ components: { securitySchemes: SCHEMES } }, {}],
  securitySchemeTypeChanged: [
    { components: { securitySchemes: SCHEMES } },
    { components: { securitySchemes: { key: { type: 'http', scheme: 'bearer' } } } },
  ],
  securitySchemeHeaderRenamed: [
    { components: { securitySchemes: SCHEMES } },
    { components: { securitySchemes: { key: { ...SCHEMES.key, name: 'X-Other' } } } },
  ],
  oauthScopeAdded: [
    { components: { securitySchemes: { o: oauth({ read: 'r' }) } } },
    { components: { securitySchemes: { o: oauth({ read: 'r', write: 'w' }) } } },
  ],
  oauthAuthorizationUrlChanged: [
    { components: { securitySchemes: { o: implicit('https://a.example/auth') } } },
    { components: { securitySchemes: { o: implicit('https://b.example/auth') } } },
  ],
  oauthTokenUrlChanged: [
    { components: { securitySchemes: { o: oauth({ read: 'r' }) } } },
    { components: { securitySchemes: { o: oauth({ read: 'r' }, 'https://b.example/token') } } },
  ],
  unreferencedSchemaRemoved: [{ components: { schemas: { Gone: S() } } }, {}],
  unreferencedSchemaChanged: [
    { components: { schemas: { Thing: S() } } },
    { components: { schemas: { Thing: S({ maxLength: 3 }) } } },
  ],
  unreferencedHeaderRemoved: [{ components: { headers: { Rate: { schema: I() } } } }, {}],
  webhookAdded: [{ webhooks: {} }, { webhooks: { ping: { post: { responses: OK } } } }],
  webhookRemoved: [{ webhooks: { ping: { post: { responses: OK } } } }, { webhooks: {} }],
  webhookPayloadTightened: [
    {
      webhooks: {
        ping: {
          post: {
            requestBody: { content: { 'application/json': { schema: S({ maxLength: 9 }) } } },
            responses: OK,
          },
        },
      },
    },
    {
      webhooks: {
        ping: {
          post: {
            requestBody: { content: { 'application/json': { schema: S({ maxLength: 3 }) } } },
            responses: OK,
          },
        },
      },
    },
  ],
  serversChanged: [
    { servers: [{ url: 'https://a.example' }] },
    { servers: [{ url: 'https://b.example' }] },
  ],
};

function documentMatrix(): Fixture[] {
  return Object.entries(DOCUMENT_CHANGES).map(([change, [before, after]]) => {
    const openapi = change.startsWith('webhook') ? '3.1.0' : '3.0.3';
    const withPaths = (doc: Doc): Doc => ({ paths: {}, ...doc });
    return {
      name: `document:${change}`,
      base: spec(openapi, {}, withPaths(before)),
      revision: spec(openapi, {}, withPaths(after)),
    };
  });
}

interface Verdict {
  readonly fixture: Fixture;
  readonly edits: number;
  readonly covered: boolean;
  readonly reported: boolean;
}

/** Speckify's static verdict: edits exist and every one matches an honoured claim. */
function staticallyCovered(
  fixture: Fixture,
  coverage: OasdiffCoverage,
): {
  edits: number;
  covered: boolean;
} {
  const edits = diffDocuments(prepareDocument(fixture.base), prepareDocument(fixture.revision));
  // Runtime corroboration is left out: this checks the static tables alone.
  const everything = edits.map((edit) => ({
    path: edit.location[1],
    operation: edit.location[2]?.toUpperCase(),
  }));
  const uncovered = findUncoveredEdits(edits, coverage, everything);
  return { edits: edits.length, covered: edits.length > 0 && uncovered.length === 0 };
}

async function runOasdiff(binary: string, base: Doc, revision: Doc): Promise<OasdiffChange[]> {
  const dir = await mkdtemp(join(tmpdir(), 'speckify-coverage-'));
  try {
    await writeFile(join(dir, 'base.json'), JSON.stringify(base));
    await writeFile(join(dir, 'revision.json'), JSON.stringify(revision));
    return await runOasdiffChangelog({
      oasdiffPath: binary,
      baseSpecPath: join(dir, 'base.json'),
      revisionSpecPath: join(dir, 'revision.json'),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Merges per-path fixtures into one document pair, so one oasdiff run judges them all. */
async function judgeByPath(binary: string, fixtures: readonly Fixture[]): Promise<Set<string>> {
  const merge = (pick: (f: Fixture) => Doc): Doc => {
    const paths: Doc = {};
    for (const fixture of fixtures) Object.assign(paths, pick(fixture).paths as Doc);
    const [first] = fixtures;
    return spec(String(first === undefined ? '3.0.3' : pick(first).openapi), paths);
  };
  const changes = await runOasdiff(
    binary,
    merge((f) => f.base),
    merge((f) => f.revision),
  );
  return new Set(changes.flatMap((change) => (change.path === undefined ? [] : [change.path])));
}

describe.skipIf(oasdiffPath === null)(
  'location coverage, validated against the real oasdiff binary',
  () => {
    let coverage: OasdiffCoverage;
    const verdicts: Verdict[] = [];

    beforeAll(async () => {
      const binary = String(oasdiffPath);
      coverage = await loadOasdiffCoverage(
        join(dataDir, OASDIFF_LOCATION_CLAIMS_FILENAME),
        join(dataDir, OASDIFF_SILENT_CLAIMS_FILENAME),
      );
      const batches = [
        schemaMatrix('3.0.3', { ...CHANGES, ...CHANGES_3_0 }),
        schemaMatrix('3.1.0', { ...CHANGES, ...CHANGES_3_1 }),
        operationMatrix(),
      ];
      for (const batch of batches) {
        const reportedPaths = await judgeByPath(binary, batch);
        for (const fixture of batch) {
          const path = Object.keys(fixture.base.paths as Doc)[0] ?? '';
          verdicts.push({
            fixture,
            ...staticallyCovered(fixture, coverage),
            reported: reportedPaths.has(path),
          });
        }
      }
      for (const fixture of documentMatrix()) {
        const changes = await runOasdiff(binary, fixture.base, fixture.revision);
        verdicts.push({
          fixture,
          ...staticallyCovered(fixture, coverage),
          reported: changes.length > 0,
        });
      }
    }, 300_000);

    it('judges a broad table of fixtures, every one a real structural change', () => {
      expect(verdicts.length).toBeGreaterThan(2000);
      expect(verdicts.filter((v) => v.edits === 0).map((v) => v.fixture.name)).toEqual([]);
      expect(verdicts.filter((v) => v.covered).length).toBeGreaterThan(500);
    });

    it('never calls a fixture covered unless oasdiff reported a change for it', () => {
      const falselyCovered = verdicts
        .filter((v) => v.covered && !v.reported)
        .map((v) => v.fixture.name);
      expect(falselyCovered).toEqual([]);
    });

    it('never calls anything under a callback, a parameter sub-schema, oneOf or not covered', () => {
      const unsafe = verdicts.filter(
        (v) =>
          v.covered &&
          /^\/(callbackBody\/|(query|deepObject|header|path|cookie)Parameter\/(?!top\/)|[^/]+\/(oneOf|not)\/)/.test(
            v.fixture.name,
          ),
      );
      expect(unsafe.map((v) => v.fixture.name)).toEqual([]);
    });
  },
);

/** A minimal published spec with one operation that has room for each reviewer scenario. */
function reviewerSpec(version: string, operation: Doc, responseProperties: Doc): Doc {
  return spec(
    '3.0.3',
    {
      '/things': {
        post: {
          operationId: 'createThing',
          ...operation,
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': { schema: { type: 'object', properties: responseProperties } },
              },
            },
          },
        },
      },
    },
    { info: { title: 'Things', version } },
  );
}

const idOnly = { id: { type: 'string' } };
const withNotes = { id: { type: 'string' }, notes: { type: 'string' } };

const callbackOperation = (payload: Schema): Doc => ({
  callbacks: {
    done: {
      '{$request.body#/url}': {
        post: {
          requestBody: { content: { 'application/json': { schema: payload } } },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  },
});
const payload = (status: Schema, name: Schema, required: string[]): Schema => ({
  type: 'object',
  required,
  properties: { status, name },
});

/** Every reviewer scenario from cycle 3: [base operation, revision operation]. */
const REVIEWER_SCENARIOS: Readonly<Record<string, readonly [Doc, Doc]>> = {
  'array query param items.maxLength 50 -> 5': [
    { parameters: [{ name: 'tags', in: 'query', schema: A({ items: S({ maxLength: 50 }) }) }] },
    { parameters: [{ name: 'tags', in: 'query', schema: A({ items: S({ maxLength: 5 }) }) }] },
  ],
  'array query param items gains enum [a, b]': [
    { parameters: [{ name: 'tags', in: 'query', schema: A() }] },
    { parameters: [{ name: 'tags', in: 'query', schema: A({ items: S({ enum: ['a', 'b'] }) }) }] },
  ],
  'deepObject param properties.name.maxLength 50 -> 5': [
    {
      parameters: [
        {
          name: 'filter',
          in: 'query',
          style: 'deepObject',
          explode: true,
          schema: { type: 'object', properties: { name: S({ maxLength: 50 }) } },
        },
      ],
    },
    {
      parameters: [
        {
          name: 'filter',
          in: 'query',
          style: 'deepObject',
          explode: true,
          schema: { type: 'object', properties: { name: S({ maxLength: 5 }) } },
        },
      ],
    },
  ],
  'callback payload status enum gains a value': [
    callbackOperation(payload(S({ enum: ['a'] }), S({ maxLength: 5 }), ['status'])),
    callbackOperation(payload(S({ enum: ['a', 'b'] }), S({ maxLength: 5 }), ['status'])),
  ],
  'callback payload maxLength relaxed': [
    callbackOperation(payload(S({ enum: ['a'] }), S({ maxLength: 5 }), ['status'])),
    callbackOperation(payload(S({ enum: ['a'] }), S({ maxLength: 50 }), ['status'])),
  ],
  'callback payload required dropped': [
    callbackOperation(payload(S({ enum: ['a'] }), S({ maxLength: 5 }), ['status'])),
    callbackOperation(payload(S({ enum: ['a'] }), S({ maxLength: 5 }), [])),
  ],
  'callback removed entirely': [
    callbackOperation(payload(S({ enum: ['a'] }), S({ maxLength: 5 }), ['status'])),
    {},
  ],
};

describe.skipIf(oasdiffPath === null)(
  'the reviewer scenarios through computeContractPlan and the real oasdiff binary',
  () => {
    let classificationMap: ClassificationMap;
    let coverage: OasdiffCoverage;

    beforeAll(async () => {
      classificationMap = await loadClassificationMap(
        join(dataDir, OASDIFF_CLASSIFICATION_MAP_FILENAME),
      );
      coverage = await loadOasdiffCoverage(
        join(dataDir, OASDIFF_LOCATION_CLAIMS_FILENAME),
        join(dataDir, OASDIFF_SILENT_CLAIMS_FILENAME),
      );
    });

    async function plan(base: Doc, revision: Doc): Promise<string> {
      const result = await computeContractPlan({
        contract: 'things',
        bundledSpec: JSON.stringify(revision),
        previous: { version: '1.2.3', bundledSpec: JSON.stringify(base), speckifyVersion: null },
        classificationMap,
        coverage,
        toolchainImpactBump: 'none',
        oasdiffPath: String(oasdiffPath),
      });
      return `${result.bump} ${result.version}`;
    }

    it.each(Object.entries(REVIEWER_SCENARIOS))(
      '%s, alongside an unrelated optional response property, is major',
      async (_name, [before, after]) => {
        const base = reviewerSpec('1.2.3', before, idOnly);
        expect(await plan(base, reviewerSpec('0.0.0', after, withNotes))).toBe('major 2.0.0');
        expect(await plan(base, reviewerSpec('0.0.0', after, idOnly))).toBe('major 2.0.0');
      },
    );

    it('the unrelated optional response property alone is minor', async () => {
      const base = reviewerSpec('1.2.3', {}, idOnly);
      expect(await plan(base, reviewerSpec('0.0.0', {}, withNotes))).toBe('minor 1.3.0');
    });

    it("a covered request-body property maxLength tightening takes oasdiff's major", async () => {
      const body = (maxLength: number): Doc => ({
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { name: S({ maxLength }) } },
            },
          },
        },
      });
      const base = reviewerSpec('1.2.3', body(50), idOnly);
      expect(await plan(base, reviewerSpec('0.0.0', body(5), withNotes))).toBe('major 2.0.0');
      // Relaxing it is covered too, so oasdiff's minor stands: proof the
      // check is not simply forcing major on everything.
      const relaxed = reviewerSpec('1.2.3', body(5), idOnly);
      expect(await plan(relaxed, reviewerSpec('0.0.0', body(50), withNotes))).toBe('minor 1.3.0');
    });

    it('a description-only edit is patch, and an unchanged spec is none', async () => {
      const base = reviewerSpec('1.2.3', {}, idOnly);
      const described = reviewerSpec('0.0.0', { description: 'Creates a thing.' }, idOnly);
      expect(await plan(base, described)).toBe('patch 1.2.4');
      expect(await plan(base, reviewerSpec('0.0.0', {}, idOnly))).toBe('none 1.2.3');
    });
  },
);

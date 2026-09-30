/**
 * A matrix of single schema changes × placements × nestings, each on its own
 * path: the input to the allow-list's property test (allow-list.md §9).
 */
export type Doc = Record<string, unknown>;
type Schema = Doc;

export interface Fixture {
  readonly name: string;
  readonly change: string;
  readonly placement: string;
  readonly nesting: string;
  readonly base: Doc;
  readonly revision: Doc;
}

export const S = (extra: Doc = {}): Schema => ({ type: 'string', ...extra });
export const I = (extra: Doc = {}): Schema => ({ type: 'integer', ...extra });
export const A = (extra: Doc = {}): Schema => ({ type: 'array', items: S(), ...extra });
export const O = (extra: Doc = {}): Schema => ({
  type: 'object',
  properties: { p: S() },
  ...extra,
});

/** Schema changes valid in OpenAPI 3.0 and 3.1: [before, after]. */
export const CHANGES: Readonly<Record<string, readonly [Schema, Schema]>> = {
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
  additionalPropertiesRemoved: [O({ additionalProperties: false }), O()],
  additionalPropertiesTrue: [O({ additionalProperties: false }), O({ additionalProperties: true })],
  requiredMemberRemoved: [
    O({ properties: { p: S(), q: S() }, required: ['p', 'q'] }),
    O({ properties: { p: S(), q: S() }, required: ['p'] }),
  ],
  requiredMemberAdded: [
    O({ properties: { p: S(), q: S() }, required: ['p'] }),
    O({ properties: { p: S(), q: S() }, required: ['p', 'q'] }),
  ],
  requiredPropertyAdd: [O(), O({ properties: { p: S(), q: S() }, required: ['q'] })],
  enumReplaced: [S({ enum: ['a', 'b'] }), S({ enum: ['a', 'c'] })],
  anyOfIntroduced: [O(), O({ anyOf: [{ required: ['p'] }] })],
  oneOfIntroduced: [O(), O({ oneOf: [{ required: ['p'] }] })],
  allOfBranchAdded: [O(), O({ allOf: [{ not: { required: ['p'] } }] })],
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
export const CHANGES_3_0: Readonly<Record<string, readonly [Schema, Schema]>> = {
  nullableSet: [S(), S({ nullable: true })],
  nullableUnset: [S({ nullable: true }), S()],
  exclusiveMinimumSet: [I({ minimum: 1 }), I({ minimum: 1, exclusiveMinimum: true })],
  exclusiveMinimumUnset: [I({ minimum: 1, exclusiveMinimum: true }), I({ minimum: 1 })],
  exclusiveMaximumSet: [I({ maximum: 1 }), I({ maximum: 1, exclusiveMaximum: true })],
};

/** Schema changes only OpenAPI 3.1 can express. */
export const CHANGES_3_1: Readonly<Record<string, readonly [Schema, Schema]>> = {
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
export const PLACEMENTS: Readonly<Record<string, (schema: Schema) => Doc>> = {
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
export const NESTINGS: Readonly<Record<string, (schema: Schema) => Schema>> = {
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

export function spec(openapi: string, paths: Doc, extra: Doc = {}): Doc {
  return { openapi, info: { title: 'Fixtures', version: '1.0.0' }, paths, ...extra };
}

/** Every placement × nesting × change, each on its own path. */
export function schemaMatrix(
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
          change,
          placement,
          nesting,
          base: spec(openapi, { [path]: { post: place(nest(before)) } }),
          revision: spec(openapi, { [path]: { post: place(nest(after)) } }),
        });
      }
    }
  }
  return fixtures;
}

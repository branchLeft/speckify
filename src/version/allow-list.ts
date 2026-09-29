import { maxBump } from './bump.js';
import { HTTP_METHODS, parameterKey, type Edit } from './structural-diff.js';
import type { Bump } from './types.js';

/** Which side of the exchange an edit affects; see allow-list.md §3. */
export type Direction = 'request' | 'response' | 'inverted' | 'none';

/** The two prepared (dereferenced) documents an edit came from. */
export interface JudgeContext {
  readonly base: Record<string, unknown>;
  readonly revision: Record<string, unknown>;
}

/** One named, reviewable entry of the allow-list. */
export interface AllowRule {
  readonly name: string;
  readonly bump: 'minor' | 'patch';
  readonly direction: Direction | 'any';
  readonly reason: string;
  readonly matches: (edit: Edit, context: JudgeContext) => boolean;
}

export interface EditJudgement {
  readonly edit: Edit;
  readonly direction: Direction;
  readonly bump: Bump;
  /** The allow-list rule that matched, or undefined when the edit is major. */
  readonly rule: string | undefined;
}

/** Extensions a pinned generator reads, so editing one changes generated code; see §6. */
export const SDK_EXTENSIONS: ReadonlySet<string> = new Set([
  'x-codeSamples',
  'x-custom',
  'x-enum-descriptions',
  'x-enum-field-as-literal',
  'x-enum-varnames',
  'x-enumNames',
  'x-internal-id',
  'x-nullable',
  'x-pattern-message',
  'x-propertyNames',
  'x-www-form-urlencoded',
]);

/** Extension families a pinned generator reads by prefix. */
export const SDK_EXTENSION_PREFIXES: readonly string[] = [
  'x-avro-',
  'x-datamodel-code-generator-',
  'x-enum-',
  'x-is-',
  'x-python-',
  'x-xsd-',
];

export function isSdkExtension(key: string): boolean {
  return SDK_EXTENSIONS.has(key) || SDK_EXTENSION_PREFIXES.some((prefix) => key.startsWith(prefix));
}

type Doc = Record<string, unknown>;

function isPlainObject(value: unknown): value is Doc {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The value at `location` in a prepared document, reading parameter lists by `in:name`. */
export function valueAt(doc: unknown, location: readonly string[]): unknown {
  let node = doc;
  for (const segment of location) {
    if (Array.isArray(node)) {
      node = node.find((item, index) => parameterKey(item, index) === segment);
    } else if (isPlainObject(node) && Object.hasOwn(node, segment)) {
      node = node[segment];
    } else {
      return undefined;
    }
  }
  return node;
}

/** `paths.<p>[.<method>]`, split from the segments after it. */
interface OperationSite {
  readonly path: string;
  readonly method: string | undefined;
  readonly rest: readonly string[];
}

function operationSite(location: readonly string[]): OperationSite | undefined {
  const [root, path, second] = location;
  if (root !== 'paths' || path === undefined) {
    return undefined;
  }
  if (second !== undefined && HTTP_METHODS.has(second)) {
    return { path, method: second, rest: location.slice(3) };
  }
  return { path, method: undefined, rest: location.slice(2) };
}

export function directionOf(location: readonly string[]): Direction {
  if (location[0] === 'webhooks') {
    return 'inverted';
  }
  const site = operationSite(location);
  const [first, , third] = site?.rest ?? [];
  if (site === undefined) {
    return 'none';
  }
  if (first === 'parameters') {
    return 'request';
  }
  if (site.method === undefined) {
    return 'none';
  }
  if (first === 'callbacks') {
    return 'inverted';
  }
  if (first === 'requestBody') {
    return 'request';
  }
  if (first === 'responses' && (third === 'content' || third === 'headers')) {
    return 'response';
  }
  return 'none';
}

/** An edit inside a parameter, body or header schema: its direction and the segments below the root. */
interface SchemaSite {
  readonly direction: 'request' | 'response';
  readonly tail: readonly string[];
}

function schemaSite(location: readonly string[]): SchemaSite | undefined {
  const site = operationSite(location);
  if (site === undefined) return undefined;
  const r = site.rest;
  const at = (start: number, direction: SchemaSite['direction']): SchemaSite | undefined => {
    if (r[start] === 'schema') return { direction, tail: r.slice(start + 1) };
    if (r[start] === 'content' && r[start + 2] === 'schema') {
      return { direction, tail: r.slice(start + 3) };
    }
    return undefined;
  };
  if (r[0] === 'parameters' && r.length > 2) return at(2, 'request');
  if (site.method === undefined) return undefined;
  if (r[0] === 'requestBody' && r[1] === 'content' && r[3] === 'schema') {
    return { direction: 'request', tail: r.slice(4) };
  }
  if (r[0] === 'responses' && r[2] === 'content' && r[4] === 'schema') {
    return { direction: 'response', tail: r.slice(5) };
  }
  if (r[0] === 'responses' && r[2] === 'headers' && r.length > 4) return at(4, 'response');
  return undefined;
}

/** True when `segments` descend only through `properties.<n>`, `items`, `allOf.<i>`, `additionalProperties` (§4). */
export function isPlainPosition(segments: readonly string[]): boolean {
  let index = 0;
  while (index < segments.length) {
    const keyword = segments[index];
    const next = segments[index + 1];
    if (keyword === 'properties' && next !== undefined) {
      index += 2;
    } else if (keyword === 'allOf' && next !== undefined && /^\d+$/.test(next)) {
      index += 2;
    } else if (keyword === 'items' || keyword === 'additionalProperties') {
      index += 1;
    } else {
      return false;
    }
  }
  return true;
}

/** The last `terminalLength` segments of a schema edit, when everything above them is plain. */
function plainSchemaEdit(
  edit: Edit,
  direction: SchemaSite['direction'] | 'any',
  terminalLength: number,
): readonly string[] | undefined {
  const site = schemaSite(edit.location);
  if (site === undefined || (direction !== 'any' && site.direction !== direction)) {
    return undefined;
  }
  if (site.tail.length < terminalLength) return undefined;
  const cut = site.tail.length - terminalLength;
  return isPlainPosition(site.tail.slice(0, cut)) ? site.tail.slice(cut) : undefined;
}

const isNonEmptyArray = (value: unknown): value is unknown[] =>
  Array.isArray(value) && value.length > 0;

type Relaxation = (edit: Edit) => boolean;
const raisedOrRemoved: Relaxation = (e) => e.action === 'increase' || e.action === 'unset';
const loweredOrRemoved: Relaxation = (e) => e.action === 'decrease' || e.action === 'unset';

/** The request-schema keywords whose relaxation the allow-list names, and what counts as relaxing. */
const REQUEST_RELAXATIONS: Readonly<Record<string, Relaxation>> = {
  maxLength: raisedOrRemoved,
  maxItems: raisedOrRemoved,
  maximum: raisedOrRemoved,
  exclusiveMaximum: raisedOrRemoved,
  minLength: loweredOrRemoved,
  minItems: loweredOrRemoved,
  minimum: loweredOrRemoved,
  exclusiveMinimum: loweredOrRemoved,
  pattern: (e) => e.action === 'unset',
  enum: (e) => e.action === 'add' && isNonEmptyArray(e.before) && Array.isArray(e.after),
  required: (e) => e.action === 'remove' && Array.isArray(e.before),
  additionalProperties: (e) => e.before === false && (e.after === true || e.after === undefined),
};

function newOptionalProperty(
  edit: Edit,
  context: JudgeContext,
  direction: SchemaSite['direction'],
): boolean {
  const terminal = plainSchemaEdit(edit, direction, 2);
  if (edit.action !== 'add' || terminal?.[0] !== 'properties') return false;
  const name = terminal[1];
  const parent = edit.location.slice(0, -2);
  const required = valueAt(context.revision, [...parent, 'required']);
  return !(Array.isArray(required) && required.includes(name));
}

const NON_PATH_PARAMETER = /^(query|header|cookie):/;

function isOptionalNonPathParameter(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    ['query', 'header', 'cookie'].includes(String(value.in)) &&
    value.required !== true
  );
}

function isOperationAdded(edit: Edit): boolean {
  const site = operationSite(edit.location);
  return edit.action === 'add' && site?.rest.length === 0;
}

function isOptionalParameterAdded(edit: Edit, context: JudgeContext): boolean {
  const site = operationSite(edit.location);
  if (edit.action !== 'add' || site === undefined) return false;
  const [list, key] = site.rest;
  if (list !== 'parameters' || key === undefined || site.rest.length !== 2) return false;
  if (!isOptionalNonPathParameter(edit.after)) return false;
  // An operation-level parameter must not shadow a path-level one of the same key.
  const pathLevel = ['paths', site.path, 'parameters', key];
  return (
    site.method === undefined ||
    (valueAt(context.base, pathLevel) === undefined &&
      valueAt(context.revision, pathLevel) === undefined)
  );
}

/** True when `value` is absent or `false`: the object declares no catch-all for other names. */
const declaresNoCatchAll = (value: unknown): boolean => value === undefined || value === false;

function isRequestOptionalPropertyAdded(edit: Edit, context: JudgeContext): boolean {
  if (!newOptionalProperty(edit, context, 'request')) return false;
  // A declared catch-all (`true` or a schema) is typed in the SDK, so
  // existing code may already send the new name with another type.
  const parent = valueAt(context.base, edit.location.slice(0, -2));
  return (
    !isPlainObject(parent) ||
    (declaresNoCatchAll(parent.additionalProperties) &&
      declaresNoCatchAll(parent.unevaluatedProperties))
  );
}

function isRequestConstraintRelaxed(edit: Edit): boolean {
  const keyword = plainSchemaEdit(edit, 'request', 1)?.[0];
  if (keyword === undefined || !Object.hasOwn(REQUEST_RELAXATIONS, keyword)) return false;
  return REQUEST_RELAXATIONS[keyword]?.(edit) === true;
}

function isParameterBecameOptional(edit: Edit): boolean {
  const site = operationSite(edit.location);
  if (site === undefined || edit.action !== 'unset' || edit.before !== true) return false;
  const [list, key, keyword] = site.rest;
  return (
    list === 'parameters' &&
    NON_PATH_PARAMETER.test(key ?? '') &&
    keyword === 'required' &&
    site.rest.length === 3
  );
}

function isResponseOptionalPropertyAdded(edit: Edit, context: JudgeContext): boolean {
  if (!newOptionalProperty(edit, context, 'response')) return false;
  const parent = valueAt(context.base, edit.location.slice(0, -2));
  return (
    !isPlainObject(parent) ||
    (parent.additionalProperties !== false && parent.unevaluatedProperties !== false)
  );
}

function isResponseOptionalHeaderAdded(edit: Edit): boolean {
  const site = operationSite(edit.location);
  if (edit.action !== 'add' || site?.method === undefined) return false;
  const [responses, , headers] = site.rest;
  return (
    responses === 'responses' &&
    headers === 'headers' &&
    site.rest.length === 4 &&
    isPlainObject(edit.after) &&
    edit.after.required !== true
  );
}

function isUnreferencedSchemaAdded(edit: Edit): boolean {
  const [root, kind] = edit.location;
  return (
    edit.action === 'add' &&
    edit.location.length === 3 &&
    root === 'components' &&
    kind === 'schemas'
  );
}

function isDeprecatedSet(edit: Edit): boolean {
  if (edit.action !== 'set' || edit.after !== true) return false;
  const site = operationSite(edit.location);
  if (site === undefined || edit.location.at(-1) !== 'deprecated') return false;
  if (site.method !== undefined && site.rest.length === 1) return true;
  if (site.rest[0] === 'parameters' && site.rest.length === 3) return true;
  return plainSchemaEdit(edit, 'any', 3)?.[0] === 'properties';
}

/**
 * The allow-list: every change shape that is minor, each with its reason.
 * An edit no rule matches is major. See allow-list.md §5 before adding one.
 */
export const ALLOW_LIST: readonly AllowRule[] = [
  {
    name: 'operation-added',
    bump: 'minor',
    direction: 'none',
    reason: 'no existing call can reach a new operation',
    matches: isOperationAdded,
  },
  {
    name: 'optional-parameter-added',
    bump: 'minor',
    direction: 'request',
    reason: 'existing calls omit a new optional query, header or cookie parameter and stay valid',
    matches: isOptionalParameterAdded,
  },
  {
    name: 'request-optional-property-added',
    bump: 'minor',
    direction: 'request',
    reason: 'existing request bodies omit a new optional property and stay valid',
    matches: isRequestOptionalPropertyAdded,
  },
  {
    name: 'request-constraint-relaxed',
    bump: 'minor',
    direction: 'request',
    reason: 'every request valid before a relaxation is still valid after it',
    matches: isRequestConstraintRelaxed,
  },
  {
    name: 'parameter-became-optional',
    bump: 'minor',
    direction: 'request',
    reason: 'existing calls still send a parameter that stopped being required',
    matches: isParameterBecameOptional,
  },
  {
    name: 'response-optional-property-added',
    bump: 'minor',
    direction: 'response',
    reason: 'clients ignore a response property they do not know',
    matches: isResponseOptionalPropertyAdded,
  },
  {
    name: 'response-optional-header-added',
    bump: 'minor',
    direction: 'response',
    reason: 'clients ignore a response header they do not know',
    matches: isResponseOptionalHeaderAdded,
  },
  {
    name: 'unreferenced-schema-added',
    bump: 'minor',
    direction: 'none',
    reason: 'a schema nothing references adds a generated type and changes none',
    matches: isUnreferencedSchemaAdded,
  },
  {
    name: 'deprecated-set',
    bump: 'minor',
    direction: 'any',
    reason: 'a deprecation is an announcement; nothing changes on the wire',
    matches: isDeprecatedSet,
  },
];

function isInertExtension(edit: Edit): boolean {
  return edit.extension === true && !isSdkExtension(edit.location.at(-1) ?? '');
}

/** The patch-level rule: an extension no pinned generator reads (§6). */
export const EXTENSION_RULE: AllowRule = {
  name: 'extension',
  bump: 'patch',
  direction: 'any',
  reason: 'a vendor extension no pinned generator reads has no effect on the wire or on SDKs',
  matches: isInertExtension,
};

/** Judges one edit: patch or minor when a rule matches, otherwise major. */
export function judgeEdit(edit: Edit, context: JudgeContext): EditJudgement {
  const direction = directionOf(edit.location);
  for (const rule of edit.extension === true ? [EXTENSION_RULE] : ALLOW_LIST) {
    if (rule.matches(edit, context)) {
      return { edit, direction, bump: rule.bump, rule: rule.name };
    }
  }
  return { edit, direction, bump: 'major', rule: undefined };
}

export function judgeEdits(edits: readonly Edit[], context: JudgeContext): EditJudgement[] {
  return edits.map((edit) => judgeEdit(edit, context));
}

/** The highest bump among judgements, `none` when there are none. */
export function allowListBump(judgements: readonly EditJudgement[]): Bump {
  return maxBump(judgements.map((judgement) => judgement.bump));
}

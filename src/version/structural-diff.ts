import { toCanonicalJson } from '../bundle/canonical-json.js';

/** Syntactic edit actions; see allow-list.md §2. */
export type EditAction =
  | 'add'
  | 'remove'
  | 'set'
  | 'unset'
  | 'change'
  | 'increase'
  | 'decrease'
  | 'reorder';

/** One structural change: a concrete location (segments, never a dotted string) and an action. */
export interface Edit {
  readonly location: readonly string[];
  readonly action: EditAction;
  /** The value at `location` in the base document (undefined when absent). */
  readonly before: unknown;
  /** The value at `location` in the revision (undefined when absent). */
  readonly after: unknown;
  /** True when the last segment is a vendor extension key, never a member name. */
  readonly extension?: true;
}

/** A document ready to diff: normalised, doc-stripped, and dereferenced outside `components`. */
export interface PreparedDocument {
  readonly doc: Record<string, unknown>;
  /** `<kind>/<name>` of every component referenced from outside `components`. */
  readonly referenced: ReadonlySet<string>;
  /** `<kind>/<name>` of every component on a reference cycle. */
  readonly cyclic: ReadonlySet<string>;
}

const PLACEHOLDER_VERSION = '0.0.0';

// A schema's `title` is not here: datamodel-code-generator can name a
// generated class after it, so editing one can rename a public type.
const DOC_ONLY_KEYS = new Set(['description', 'summary', 'example', 'examples', 'externalDocs']);

const ROOT_ANNOTATION_KEYS = new Set(['tags']);
const INFO_ANNOTATION_KEYS = new Set(['contact', 'license', 'termsOfService', 'title']);

/** Keys whose children are producer-chosen names, never keywords. */
const NAME_MAP_KEYS = new Set([
  'paths',
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
  'schemas',
  'responses',
  'content',
  'parameters',
  'securitySchemes',
  'webhooks',
  'callbacks',
  'headers',
  'examples',
  'requestBodies',
  'links',
  'mapping',
  'dependentRequired',
  'dependentSchemas',
  'encoding',
  'scopes',
  'variables',
  'pathItems',
]);

/** Component kinds reused by `$ref`, whose content is judged where it is used. */
const REUSE_COMPONENT_KINDS = new Set([
  'schemas',
  'parameters',
  'responses',
  'requestBodies',
  'headers',
  'callbacks',
  'pathItems',
  'links',
  'examples',
]);

export const HTTP_METHODS: ReadonlySet<string> = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
  'query',
]);

/** Keys compared as one opaque value, whatever their JSON type. */
const ATOMIC_KEYS = new Set(['default', 'const', '$ref']);

/** Keys whose value is instance data, never annotated schema: stripping stops at them. */
const VALUE_KEYS = new Set(['default', 'const', 'enum']);

/** Marks an inlined component schema with the component it came from; see allow-list.md §1. */
export const REF_TARGET_KEY = '$refTarget';

function isExtensionKey(key: string, parentIsNameMap: boolean): boolean {
  return !parentIsNameMap && key.startsWith('x-');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  return toCanonicalJson(a) === toCanonicalJson(b);
}

/**
 * Removes annotation keys, except where a key is a member name of a name
 * map (a property called `title` is data) or inside a value. See allow-list.md §1.
 */
export function stripDocOnlyKeys(value: unknown, parentIsNameMap = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripDocOnlyKeys(item, false));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (!parentIsNameMap && DOC_ONLY_KEYS.has(key)) {
      continue;
    }
    if (!parentIsNameMap && VALUE_KEYS.has(key)) {
      result[key] = val;
      continue;
    }
    result[key] = stripDocOnlyKeys(val, NAME_MAP_KEYS.has(key) && isPlainObject(val));
  }
  return result;
}

/** Removes vendor extension keys in keyword position, leaving member names and values alone. */
export function stripExtensionKeys(value: unknown, parentIsNameMap = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripExtensionKeys(item, false));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (isExtensionKey(key, parentIsNameMap)) continue;
    result[key] =
      !parentIsNameMap && VALUE_KEYS.has(key)
        ? val
        : stripExtensionKeys(val, NAME_MAP_KEYS.has(key) && isPlainObject(val));
  }
  return result;
}

/** Normalises `info.version` and strips annotations, including root-level ones. */
export function normalizeForComparison(raw: Record<string, unknown>): Record<string, unknown> {
  const stripped = stripDocOnlyKeys(raw) as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stripped)) {
    if (ROOT_ANNOTATION_KEYS.has(key)) {
      continue;
    }
    if (key === 'info' && isPlainObject(value)) {
      const info: Record<string, unknown> = { version: PLACEHOLDER_VERSION };
      for (const [infoKey, infoValue] of Object.entries(value)) {
        if (infoKey !== 'version' && !INFO_ANNOTATION_KEYS.has(infoKey)) {
          info[infoKey] = infoValue;
        }
      }
      result[key] = info;
      continue;
    }
    result[key] = value;
  }
  return result;
}

function decodePointerSegment(segment: string): string {
  return decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveLocalRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) {
    return undefined;
  }
  let node: unknown = root;
  for (const raw of ref.slice(1).split('/').slice(1)) {
    const segment = decodePointerSegment(raw);
    if (Array.isArray(node) && /^\d+$/.test(segment)) {
      node = node[Number(segment)];
    } else if (isPlainObject(node) && Object.hasOwn(node, segment)) {
      node = node[segment];
    } else {
      return undefined;
    }
  }
  return node;
}

/** `<kind>/<name>` for a `#/components/<kind>/<name>` reference, else undefined. */
function componentKeyOf(ref: string): string | undefined {
  const parts = ref.split('/');
  if (parts.length !== 4 || parts[0] !== '#' || parts[1] !== 'components') {
    return undefined;
  }
  return `${decodePointerSegment(parts[2] ?? '')}/${decodePointerSegment(parts[3] ?? '')}`;
}

class Dereferencer {
  readonly referenced = new Set<string>();
  readonly cyclic = new Set<string>();
  private readonly memo = new Map<string, unknown>();
  private cycleHits = 0;

  constructor(private readonly root: Record<string, unknown>) {}

  inline(value: unknown, stack: readonly string[], parentIsNameMap = false): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.inline(item, stack));
    }
    if (!isPlainObject(value)) {
      return value;
    }
    const ref = parentIsNameMap ? undefined : value.$ref;
    if (typeof ref !== 'string') {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = isExtensionKey(key, parentIsNameMap)
          ? val
          : this.inline(val, stack, NAME_MAP_KEYS.has(key) && isPlainObject(val));
      }
      return result;
    }
    const siblings: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (key !== '$ref') siblings[key] = val;
    }
    const resolved = this.resolve(ref, stack);
    const marked =
      isPlainObject(resolved) && ref.startsWith('#/components/schemas/') && !('$ref' in resolved)
        ? { ...resolved, [REF_TARGET_KEY]: ref }
        : resolved;
    if (Object.keys(siblings).length === 0) {
      return marked;
    }
    const inlinedSiblings = this.inline(siblings, stack);
    return isPlainObject(marked)
      ? { ...marked, $refSiblings: inlinedSiblings }
      : { $ref: ref, $refSiblings: inlinedSiblings };
  }

  private resolve(ref: string, stack: readonly string[]): unknown {
    const component = componentKeyOf(ref);
    if (component !== undefined) {
      this.referenced.add(component);
    }
    const onStack = stack.indexOf(ref);
    if (onStack !== -1) {
      this.cycleHits += 1;
      for (const member of stack.slice(onStack)) {
        const key = componentKeyOf(member);
        if (key !== undefined) {
          this.cyclic.add(key);
        }
      }
      return { $ref: ref };
    }
    if (this.memo.has(ref)) {
      return this.memo.get(ref);
    }
    const target = resolveLocalRef(this.root, ref);
    if (target === undefined) {
      return { $ref: ref };
    }
    const hitsBefore = this.cycleHits;
    const expanded = this.inline(target, [...stack, ref]);
    if (this.cycleHits === hitsBefore) {
      this.memo.set(ref, expanded);
    }
    return expanded;
  }
}

/** Normalises, strips and dereferences a parsed spec. See allow-list.md §1. */
export function prepareDocument(raw: Record<string, unknown>): PreparedDocument {
  const normalized = normalizeForComparison(raw);
  const dereferencer = new Dereferencer(normalized);
  const doc: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(normalized)) {
    doc[key] =
      key === 'components' || isExtensionKey(key, false)
        ? value
        : dereferencer.inline(value, [], NAME_MAP_KEYS.has(key) && isPlainObject(value));
  }
  return { doc, referenced: dereferencer.referenced, cyclic: dereferencer.cyclic };
}

class Differ {
  readonly edits: Edit[] = [];

  constructor(
    private readonly base: PreparedDocument,
    private readonly revision: PreparedDocument,
  ) {}

  private emit(
    location: readonly string[],
    action: EditAction,
    before: unknown,
    after: unknown,
  ): void {
    this.edits.push({ location, action, before, after });
  }

  private emitExtension(location: readonly string[], before: unknown, after: unknown): void {
    const action = before === undefined ? 'add' : after === undefined ? 'remove' : 'change';
    this.edits.push({ location, action, before, after, extension: true });
  }

  diffRoot(): void {
    const a = this.base.doc;
    const b = this.revision.doc;
    const { components: aComponents, ...aRest } = a;
    const { components: bComponents, ...bRest } = b;
    this.diffObject([], aRest, bRest);
    this.diffComponents(
      isPlainObject(aComponents) ? aComponents : {},
      isPlainObject(bComponents) ? bComponents : {},
    );
  }

  private diffComponents(a: Record<string, unknown>, b: Record<string, unknown>): void {
    for (const kind of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const av = a[kind];
      const bv = b[kind];
      const reusable =
        (isPlainObject(av) || av === undefined) && (isPlainObject(bv) || bv === undefined);
      if (!REUSE_COMPONENT_KINDS.has(kind) || !reusable) {
        this.diffKey(['components'], kind, av, bv);
        continue;
      }
      const aMap = isPlainObject(av) ? av : {};
      const bMap = isPlainObject(bv) ? bv : {};
      for (const name of new Set([...Object.keys(aMap), ...Object.keys(bMap)])) {
        this.diffComponent(kind, name, aMap[name], bMap[name]);
      }
    }
  }

  private diffComponent(kind: string, name: string, av: unknown, bv: unknown): void {
    const key = `${kind}/${name}`;
    const location = ['components', kind, name];
    const inBase = this.base.referenced.has(key);
    const inRevision = this.revision.referenced.has(key);
    if (bv === undefined) {
      if (!inBase) this.emit(location, 'remove', av, bv);
      return;
    }
    if (av === undefined) {
      if (!inRevision) this.emit(location, 'add', av, bv);
      return;
    }
    if (same(av, bv)) {
      return;
    }
    const cyclic = this.base.cyclic.has(key) || this.revision.cyclic.has(key);
    if (!inBase || !inRevision || cyclic) {
      this.emit(location, 'change', av, bv);
    }
  }

  private diffObject(
    location: readonly string[],
    a: Record<string, unknown>,
    b: Record<string, unknown>,
  ): void {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      this.diffKey(location, key, a[key], b[key]);
    }
  }

  private diffKey(location: readonly string[], key: string, av: unknown, bv: unknown): void {
    if (same(av, bv)) {
      return;
    }
    const here = [...location, key];
    if (key.startsWith('x-')) {
      this.emitExtension(here, av, bv);
      return;
    }
    if (ATOMIC_KEYS.has(key)) {
      this.diffScalar(here, av, bv, true);
      return;
    }
    if (key === 'type') {
      this.diffMemberSet(here, toTypeList(av), toTypeList(bv), av, bv);
      return;
    }
    if (key === 'parameters' && (Array.isArray(av) || Array.isArray(bv))) {
      this.diffKeyedList(here, av, bv, parameterKey);
      this.diffOrder(here, av, bv, parameterKey);
      return;
    }
    if (key === 'security' && (Array.isArray(av) || Array.isArray(bv))) {
      this.diffKeyedList(here, av, bv, securityRequirementKey, true);
      return;
    }
    if (Array.isArray(av) || Array.isArray(bv)) {
      this.diffArray(here, av, bv);
      return;
    }
    const aIsMap = isPlainObject(av) || av === undefined;
    const bIsMap = isPlainObject(bv) || bv === undefined;
    if (NAME_MAP_KEYS.has(key) && aIsMap && bIsMap) {
      this.diffNameMap(here, isPlainObject(av) ? av : {}, isPlainObject(bv) ? bv : {});
      return;
    }
    if (HTTP_METHODS.has(key) && (av === undefined || bv === undefined)) {
      this.emitMembership(here, av, bv, 'change');
      return;
    }
    if (isPlainObject(av) && isPlainObject(bv)) {
      this.diffObject(here, av, bv);
      return;
    }
    this.diffScalar(here, av, bv, key === 'additionalProperties');
  }

  private diffNameMap(
    location: readonly string[],
    a: Record<string, unknown>,
    b: Record<string, unknown>,
    membersAreNameMaps = false,
  ): void {
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const av = a[name];
      const bv = b[name];
      if (same(av, bv)) {
        continue;
      }
      const here = [...location, name];
      if (av === undefined || bv === undefined) {
        this.emitMembership(here, av, bv, 'change');
      } else if (isPlainObject(av) && isPlainObject(bv)) {
        if (membersAreNameMaps) this.diffNameMap(here, av, bv);
        else this.diffObject(here, av, bv);
      } else if (Array.isArray(av) || Array.isArray(bv)) {
        this.diffArray(here, av, bv);
      } else {
        this.emit(here, 'change', av, bv);
      }
    }
  }

  private diffKeyedList(
    location: readonly string[],
    av: unknown,
    bv: unknown,
    keyOf: (item: unknown, index: number) => string,
    membersAreNameMaps = false,
  ): void {
    const toMap = (list: unknown): Record<string, unknown> => {
      const map: Record<string, unknown> = {};
      if (Array.isArray(list)) {
        list.forEach((item, index) => {
          map[keyOf(item, index)] = item;
        });
      }
      return map;
    };
    this.diffNameMap(location, toMap(av), toMap(bv), membersAreNameMaps);
  }

  /** A reorder of the members both lists share: SDK signatures can follow list order. */
  private diffOrder(
    location: readonly string[],
    av: unknown,
    bv: unknown,
    keyOf: (item: unknown, index: number) => string,
  ): void {
    const keys = (list: unknown): string[] =>
      Array.isArray(list) ? list.map((item, index) => keyOf(item, index)) : [];
    const aKeys = keys(av);
    const bKeys = keys(bv);
    const aShared = aKeys.filter((key) => bKeys.includes(key));
    const bShared = bKeys.filter((key) => aKeys.includes(key));
    if (aShared.join('\n') !== bShared.join('\n')) {
      this.emit(location, 'reorder', av, bv);
    }
  }

  private diffArray(location: readonly string[], av: unknown, bv: unknown): void {
    const aList: unknown[] | undefined = Array.isArray(av) ? (av as unknown[]) : undefined;
    const bList: unknown[] | undefined = Array.isArray(bv) ? (bv as unknown[]) : undefined;
    if ((av !== undefined && aList === undefined) || (bv !== undefined && bList === undefined)) {
      this.diffScalar(location, av, bv, true);
      return;
    }
    const all = [...(aList ?? []), ...(bList ?? [])];
    if (all.every((item) => !isPlainObject(item) && !Array.isArray(item))) {
      this.diffMemberSet(location, aList ?? [], bList ?? [], av, bv);
      return;
    }
    this.diffKeyedList(location, av, bv, (_item, index) => String(index));
  }

  private diffMemberSet(
    location: readonly string[],
    aList: readonly unknown[],
    bList: readonly unknown[],
    before: unknown,
    after: unknown,
  ): void {
    const aKeys = new Set(aList.map((item) => toCanonicalJson(item)));
    const bKeys = new Set(bList.map((item) => toCanonicalJson(item)));
    if ([...bKeys].some((item) => !aKeys.has(item))) {
      this.emit(location, 'add', before, after);
    }
    if ([...aKeys].some((item) => !bKeys.has(item))) {
      this.emit(location, 'remove', before, after);
    }
  }

  private emitMembership(
    location: readonly string[],
    av: unknown,
    bv: unknown,
    changed: EditAction,
  ): void {
    const action = av === undefined ? 'add' : bv === undefined ? 'remove' : changed;
    this.emit(location, action, av, bv);
  }

  private diffScalar(location: readonly string[], av: unknown, bv: unknown, opaque: boolean): void {
    if (!opaque && typeof av === 'number' && typeof bv === 'number') {
      this.emit(location, bv > av ? 'increase' : 'decrease', av, bv);
      return;
    }
    const aBool = av === undefined || typeof av === 'boolean';
    const bBool = bv === undefined || typeof bv === 'boolean';
    if (!opaque && aBool && bBool) {
      // absent <-> false is not oasdiff's set/unset (a default may differ, as with `explode`)
      const action = bv === true ? 'set' : av === true ? 'unset' : 'change';
      this.emit(location, action, av, bv);
      return;
    }
    const action = av === undefined ? 'set' : bv === undefined ? 'unset' : 'change';
    this.emit(location, action, av, bv);
  }
}

function toTypeList(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** How an operation parameter is addressed in an edit's location: `in:name`. */
export function parameterKey(item: unknown, index: number): string {
  if (isPlainObject(item) && typeof item.in === 'string' && typeof item.name === 'string') {
    return `${item.in}:${item.name}`;
  }
  return isPlainObject(item) && typeof item.$ref === 'string' ? item.$ref : `#${String(index)}`;
}

function securityRequirementKey(item: unknown): string {
  return isPlainObject(item) ? Object.keys(item).sort().join('&') : toCanonicalJson(item);
}

/** Every structural edit between two prepared documents. See allow-list.md §2. */
export function diffDocuments(base: PreparedDocument, revision: PreparedDocument): Edit[] {
  const differ = new Differ(base, revision);
  differ.diffRoot();
  return differ.edits;
}

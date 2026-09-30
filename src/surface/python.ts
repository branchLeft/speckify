import { fileURLToPath } from 'node:url';

import { runUvOrThrow, type UvRunnerDeps } from '../codegen/python/uv.js';
import type { Role, SurfaceChange } from './types.js';

/** An annotation as `extract_surface.py` describes griffe's expression tree. */
export type Annotation =
  | null
  | { readonly n: string }
  | { readonly t: string }
  | { readonly c: string }
  | { readonly u: readonly Annotation[] }
  | { readonly l: readonly Annotation[] }
  | { readonly sub: Annotation; readonly args: readonly Annotation[] };

export interface PyParam {
  readonly name: string;
  readonly kind: string;
  readonly default: boolean;
  readonly annotation: Annotation;
}

export type PyMember =
  | { readonly kind: 'function'; readonly params: readonly PyParam[]; readonly returns: Annotation }
  | {
      readonly kind: 'class';
      readonly bases: readonly string[];
      readonly protocol: boolean;
      readonly init: readonly PyParam[] | null;
      readonly members: Readonly<Record<string, PyMember>>;
    }
  | { readonly kind: 'attribute'; readonly annotation: Annotation; readonly value: string | null }
  | { readonly kind: 'alias'; readonly target: string };

export interface PySurface {
  readonly modules: Readonly<Record<string, Readonly<Record<string, PyMember>>>>;
}

const EXTRACT_SCRIPT = fileURLToPath(new URL('./python/extract_surface.py', import.meta.url));

/** Loads a generated package's surface with griffe, through the pinned toolchain. */
export async function extractPythonSurface(
  searchPath: string,
  importName: string,
  toolchainDir: string,
  uvDeps: UvRunnerDeps = {},
): Promise<PySurface> {
  const result = await runUvOrThrow(
    ['python', EXTRACT_SCRIPT, searchPath, importName],
    toolchainDir,
    uvDeps,
  );
  return JSON.parse(result.stdout) as PySurface;
}

const json = (value: unknown): string => JSON.stringify(value);
const POSITIONAL = new Set(['positional-only', 'positional or keyword']);
const VARIADIC = new Set(['variadic positional', 'variadic keyword']);

function namesIn(annotation: Annotation, into: Set<string>): Set<string> {
  if (annotation === null) return into;
  if ('n' in annotation) into.add(annotation.n);
  if ('u' in annotation) annotation.u.forEach((a) => namesIn(a, into));
  if ('l' in annotation) annotation.l.forEach((a) => namesIn(a, into));
  if ('sub' in annotation) {
    namesIn(annotation.sub, into);
    annotation.args.forEach((a) => namesIn(a, into));
  }
  return into;
}

function classes(surface: PySurface): Map<string, Extract<PyMember, { kind: 'class' }>> {
  const found = new Map<string, Extract<PyMember, { kind: 'class' }>>();
  for (const [modulePath, members] of Object.entries(surface.modules)) {
    for (const [name, member] of Object.entries(members)) {
      if (member.kind === 'class') found.set(`${modulePath}.${name}`, member);
    }
  }
  return found;
}

/**
 * The direction each class is reached in: public function parameters are
 * input, returns output, a `Protocol` flips both, and a class passes its
 * roles on to the classes its fields name. See surface.md §4.
 */
export function pythonRoles(surface: PySurface): Map<string, Set<Role>> {
  const roles = new Map<string, Set<Role>>();
  const all = classes(surface);
  const pending: [string, Role][] = [];
  const reach = (annotation: Annotation, role: Role): void => {
    for (const name of namesIn(annotation, new Set())) pending.push([name, role]);
  };
  const seedFunction = (member: PyMember, flipped: boolean): void => {
    if (member.kind !== 'function') return;
    member.params.forEach((param) => {
      reach(param.annotation, flipped ? 'output' : 'input');
    });
    reach(member.returns, flipped ? 'input' : 'output');
  };
  for (const members of Object.values(surface.modules)) {
    for (const member of Object.values(members)) {
      seedFunction(member, false);
      if (member.kind === 'class') {
        Object.values(member.members).forEach((m) => {
          seedFunction(m, member.protocol);
        });
      }
    }
  }
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [name, role] = next;
    const cls = all.get(name);
    const known = roles.get(name) ?? new Set<Role>();
    if (cls === undefined || known.has(role)) continue;
    roles.set(name, known.add(role));
    cls.init?.forEach((param) => {
      reach(param.annotation, role);
    });
    Object.values(cls.members).forEach((m) => {
      if (m.kind === 'attribute') reach(m.annotation, role);
    });
  }
  return roles;
}

type Verdict = 'same' | 'compatible' | 'incompatible';

/** An annotation change judged as a set of union members in `roles`; see surface.md §4. */
export function compareAnnotations(
  previous: Annotation,
  current: Annotation,
  roles: ReadonlySet<Role>,
): Verdict {
  if (json(previous) === json(current)) return 'same';
  const members = (a: Annotation): Set<string> =>
    new Set(a !== null && 'u' in a ? a.u.map(json) : [json(a)]);
  const before = members(previous);
  const after = members(current);
  const within = (a: Set<string>, b: Set<string>): boolean => [...a].every((m) => b.has(m));
  if (roles.has('input') && !within(before, after)) return 'incompatible';
  if (roles.has('output') && !within(after, before)) return 'incompatible';
  return 'compatible';
}

const BOTH: ReadonlySet<Role> = new Set<Role>(['input', 'output']);
const INPUT: ReadonlySet<Role> = new Set<Role>(['input']);
const OUTPUT: ReadonlySet<Role> = new Set<Role>(['output']);

class PythonComparison {
  readonly changes: SurfaceChange[] = [];

  constructor(private readonly roles: Map<string, Set<Role>>) {}

  add(symbol: string, bump: 'minor' | 'major', reason: string): void {
    this.changes.push({ language: 'python', symbol, bump, reason });
  }

  rolesOf(path: string): ReadonlySet<Role> {
    const found = this.roles.get(path);
    return found === undefined || found.size === 0 ? BOTH : found;
  }

  /** A call that ran against `previous` must still run against `current`. */
  callable(symbol: string, previous: readonly PyParam[], current: readonly PyParam[]): void {
    const positional = (params: readonly PyParam[]): string[] =>
      params.filter((p) => POSITIONAL.has(p.kind)).map((p) => p.name);
    const before = positional(previous);
    const after = positional(current);
    for (const param of previous) {
      const at = `${symbol}(${param.name})`;
      const match = current.find((p) =>
        VARIADIC.has(param.kind) ? p.kind === param.kind : p.name === param.name,
      );
      if (match === undefined) {
        this.add(at, 'major', 'parameter removed');
        continue;
      }
      if (param.default && !match.default) this.add(at, 'major', 'parameter lost its default');
      if (POSITIONAL.has(param.kind) && !POSITIONAL.has(match.kind)) {
        this.add(at, 'major', 'parameter can no longer be passed by position');
      } else if (
        POSITIONAL.has(param.kind) &&
        before.indexOf(param.name) !== after.indexOf(param.name)
      ) {
        this.add(at, 'major', 'parameter moved to another position');
      }
      if (param.kind !== 'positional-only' && match.kind === 'positional-only') {
        this.add(at, 'major', 'parameter can no longer be passed by keyword');
      }
      this.annotation(at, param.annotation, match.annotation, INPUT);
    }
    for (const param of current) {
      if (previous.some((p) => p.name === param.name)) continue;
      const required = !param.default && !VARIADIC.has(param.kind);
      this.add(
        `${symbol}(${param.name})`,
        required ? 'major' : 'minor',
        required ? 'new required parameter' : 'new optional parameter',
      );
    }
    if (json(previous) !== json(current)) this.add(symbol, 'minor', 'signature changed');
  }

  annotation(
    symbol: string,
    previous: Annotation,
    current: Annotation,
    roles: ReadonlySet<Role>,
  ): void {
    const verdict = compareAnnotations(previous, current, roles);
    if (verdict === 'incompatible') this.add(symbol, 'major', 'annotation changed incompatibly');
    if (verdict === 'compatible') this.add(symbol, 'minor', 'annotation changed compatibly');
  }

  members(
    symbol: string,
    previous: Readonly<Record<string, PyMember>>,
    current: Readonly<Record<string, PyMember>>,
    classPath: string | undefined,
  ): void {
    for (const [name, member] of Object.entries(previous)) {
      const match = current[name];
      if (match === undefined) this.add(`${symbol}.${name}`, 'major', 'removed');
      else this.member(`${symbol}.${name}`, member, match, classPath);
    }
    for (const name of Object.keys(current)) {
      if (!(name in previous)) this.add(`${symbol}.${name}`, 'minor', 'added');
    }
  }

  member(symbol: string, previous: PyMember, current: PyMember, classPath?: string): void {
    if (json(previous) === json(current)) return;
    if (previous.kind === 'function' && current.kind === 'function') {
      this.callable(symbol, previous.params, current.params);
      this.annotation(`${symbol}()`, previous.returns, current.returns, OUTPUT);
    } else if (previous.kind === 'class' && current.kind === 'class') {
      this.klass(symbol, previous, current);
    } else if (previous.kind === 'attribute' && current.kind === 'attribute') {
      const roles = classPath === undefined ? BOTH : this.rolesOf(classPath);
      this.annotation(symbol, previous.annotation, current.annotation, roles);
      if (previous.value !== current.value) this.add(symbol, 'minor', 'value changed');
    } else if (previous.kind === 'alias' && current.kind === 'alias') {
      this.add(symbol, 'major', `now re-exports ${current.target}, not ${previous.target}`);
    } else {
      this.add(symbol, 'major', `changed from ${previous.kind} to ${current.kind}`);
    }
  }

  klass(
    symbol: string,
    previous: Extract<PyMember, { kind: 'class' }>,
    current: Extract<PyMember, { kind: 'class' }>,
  ): void {
    for (const base of previous.bases) {
      if (!current.bases.includes(base))
        this.add(symbol, 'major', `no longer derives from ${base}`);
    }
    if (current.bases.some((base) => !previous.bases.includes(base))) {
      this.add(symbol, 'minor', 'gained a base class');
    }
    if (previous.protocol || current.protocol) {
      this.add(symbol, 'major', 'a Protocol consumers implement changed');
      return;
    }
    const roles = this.rolesOf(symbol);
    if (roles.has('input') && previous.init !== null && current.init !== null) {
      this.callable(`${symbol}.__init__`, previous.init, current.init);
    } else if (json(previous.init) !== json(current.init)) {
      const bump = previous.init !== null && current.init === null ? 'major' : 'minor';
      this.add(`${symbol}.__init__`, bump, 'constructor changed');
    }
    this.members(symbol, previous.members, current.members, symbol);
  }
}

/** Compares two Python surfaces extracted by griffe; see surface.md §4. */
export function comparePythonSurfaces(previous: PySurface, current: PySurface): SurfaceChange[] {
  const roles = pythonRoles(previous);
  for (const [path, found] of pythonRoles(current)) {
    roles.set(path, new Set([...(roles.get(path) ?? []), ...found]));
  }
  const comparison = new PythonComparison(roles);
  for (const [modulePath, members] of Object.entries(previous.modules)) {
    const match = current.modules[modulePath];
    if (match === undefined) comparison.add(modulePath, 'major', 'module removed');
    else comparison.members(modulePath, members, match, undefined);
  }
  for (const modulePath of Object.keys(current.modules)) {
    if (!(modulePath in previous.modules)) comparison.add(modulePath, 'minor', 'module added');
  }
  return comparison.changes;
}

import { describe, expect, it } from 'vitest';

import {
  compareAnnotations,
  comparePythonSurfaces,
  pythonRoles,
  type Annotation,
  type PyMember,
  type PyParam,
  type PySurface,
} from './python.js';
import type { SurfaceChange } from './types.js';

const n = (name: string): Annotation => ({ n: name });
const union = (...names: string[]): Annotation => ({ u: names.map(n) });

const param = (name: string, extra: Partial<PyParam> = {}): PyParam => ({
  name,
  kind: 'positional or keyword',
  default: false,
  annotation: n('str'),
  ...extra,
});

const fn = (params: PyParam[], returns: Annotation = n('None')): PyMember => ({
  kind: 'function',
  params,
  returns,
});

const cls = (
  init: PyParam[] | null,
  members: Record<string, PyMember> = {},
  extra: { bases?: string[]; protocol?: boolean } = {},
): PyMember => ({
  kind: 'class',
  bases: extra.bases ?? [],
  protocol: extra.protocol ?? false,
  init,
  members,
});

const attribute = (annotation: Annotation, value: string | null = null): PyMember => ({
  kind: 'attribute',
  annotation,
  value,
});

const surface = (modules: Record<string, Record<string, PyMember>>): PySurface => ({ modules });

/** A package whose `send` takes `Body` and returns `Reply`, fixing both directions. */
function sdk(
  body: PyMember,
  reply: PyMember = cls(null),
  extra: Record<string, PyMember> = {},
): PySurface {
  return surface({
    pkg: {
      send: fn(
        [param('body', { kind: 'keyword-only', annotation: n('pkg.Body') })],
        n('pkg.Reply'),
      ),
      Body: body,
      Reply: reply,
      ...extra,
    },
  });
}

const majors = (changes: readonly SurfaceChange[]): string[] =>
  changes.filter((c) => c.bump === 'major').map((c) => `${c.symbol}: ${c.reason}`);

describe('comparePythonSurfaces', () => {
  it('reports nothing for identical surfaces', () => {
    const same = sdk(cls([param('a')]));
    expect(comparePythonSurfaces(same, same)).toEqual([]);
  });

  it('is major for a removed module or name, minor for an added one', () => {
    const before = surface({ pkg: { a: fn([]) }, 'pkg.alpha': {} });
    const after = surface({ pkg: { b: fn([]) }, 'pkg.beta': {} });
    const changes = comparePythonSurfaces(before, after);
    expect(majors(changes).sort()).toEqual(['pkg.a: removed', 'pkg.alpha: module removed']);
    expect(
      changes
        .filter((c) => c.bump === 'minor')
        .map((c) => c.symbol)
        .sort(),
    ).toEqual(['pkg.b', 'pkg.beta']);
  });

  it('a positional constructor argument that moves is major; one appended with a default is minor', () => {
    const before = sdk(cls([param('a'), param('c', { default: true })]));
    const moved = sdk(
      cls([param('a'), param('b', { default: true }), param('c', { default: true })]),
    );
    expect(majors(comparePythonSurfaces(before, moved))).toEqual([
      'pkg.Body.__init__(c): parameter moved to another position',
    ]);
    const appended = sdk(
      cls([param('a'), param('c', { default: true }), param('d', { default: true })]),
    );
    const changes = comparePythonSurfaces(before, appended);
    expect(majors(changes)).toEqual([]);
    expect(changes.map((c) => c.bump)).toContain('minor');
  });

  it('a class reached only as output keeps its constructor unjudged', () => {
    const before = sdk(cls(null), cls([param('a'), param('b')]));
    const after = sdk(cls(null), cls([param('b'), param('a')]));
    const changes = comparePythonSurfaces(before, after);
    expect(majors(changes)).toEqual([]);
    expect(changes).toContainEqual(
      expect.objectContaining({ symbol: 'pkg.Reply.__init__', bump: 'minor' }),
    );
  });

  it.each([
    ['removed', [param('a')], [], 'parameter removed'],
    [
      'lost its default',
      [param('a', { default: true })],
      [param('a')],
      'parameter lost its default',
    ],
    [
      'became keyword-only',
      [param('a')],
      [param('a', { kind: 'keyword-only' })],
      'parameter can no longer be passed by position',
    ],
    [
      'became positional-only',
      [param('a', { kind: 'keyword-only' })],
      [param('a', { kind: 'positional-only' })],
      'parameter can no longer be passed by keyword',
    ],
    ['new and required', [], [param('a')], 'new required parameter'],
    [
      'narrowed as input',
      [param('a', { annotation: union('int', 'str') })],
      [param('a', { annotation: n('str') })],
      'annotation changed incompatibly',
    ],
  ])('a parameter that %s is major', (_label, before, after, reason) => {
    const changes = comparePythonSurfaces(
      surface({ pkg: { f: fn(before) } }),
      surface({ pkg: { f: fn(after) } }),
    );
    expect(majors(changes).join()).toContain(reason);
  });

  it('allows a keyword-only parameter to become positional-or-keyword, and a new optional one', () => {
    const changes = comparePythonSurfaces(
      surface({ pkg: { f: fn([param('a', { kind: 'keyword-only' })]) } }),
      surface({
        pkg: { f: fn([param('a'), param('b', { default: true, kind: 'keyword-only' })]) },
      }),
    );
    expect(majors(changes)).toEqual([]);
  });

  it('matches variadic parameters by kind', () => {
    const star = param('args', { kind: 'variadic positional' });
    const changes = comparePythonSurfaces(
      surface({ pkg: { f: fn([star]), g: fn([star]) } }),
      surface({ pkg: { f: fn([{ ...star, name: 'rest' }]), g: fn([]) } }),
    );
    expect(majors(changes)).toEqual(['pkg.g(args): parameter removed']);
  });

  it('a return annotation may narrow but not widen', () => {
    const before = surface({ pkg: { f: fn([], union('A', 'B')) } });
    expect(majors(comparePythonSurfaces(before, surface({ pkg: { f: fn([], n('A')) } })))).toEqual(
      [],
    );
    expect(
      majors(comparePythonSurfaces(before, surface({ pkg: { f: fn([], union('A', 'B', 'C')) } }))),
    ).toEqual(['pkg.f(): annotation changed incompatibly']);
  });

  it('judges a field annotation in the direction its class is reached', () => {
    const body = (a: Annotation): PyMember => cls(null, { a: attribute(a) });
    const widened = comparePythonSurfaces(sdk(body(n('str'))), sdk(body(union('int', 'str'))));
    expect(majors(widened)).toEqual([]);
    const narrowed = comparePythonSurfaces(sdk(body(union('int', 'str'))), sdk(body(n('str'))));
    expect(majors(narrowed)).toEqual(['pkg.Body.a: annotation changed incompatibly']);
  });

  it('needs an unreached class field annotation to stay the same', () => {
    const lone = (a: Annotation): PySurface =>
      surface({ pkg: { Lone: cls(null, { a: attribute(a) }) } });
    expect(majors(comparePythonSurfaces(lone(n('str')), lone(union('int', 'str'))))).toEqual([
      'pkg.Lone.a: annotation changed incompatibly',
    ]);
  });

  it('is major for any change to a Protocol consumers implement, including a new method', () => {
    const handlers = (methods: Record<string, PyMember>): PySurface =>
      surface({
        pkg: { Handlers: cls(null, methods, { bases: ['typing.Protocol'], protocol: true }) },
      });
    const changes = comparePythonSurfaces(
      handlers({ a: fn([]) }),
      handlers({ a: fn([]), b: fn([]) }),
    );
    expect(majors(changes)).toEqual(['pkg.Handlers: a Protocol consumers implement changed']);
  });

  it('is major for a lost base, a changed re-export, a changed kind and a lost constructor', () => {
    const before = surface({
      pkg: {
        A: cls(null, {}, { bases: ['pkg.Base'] }),
        B: { kind: 'alias', target: 'pkg.x.B' },
        C: fn([]),
        D: cls([param('a')]),
        E: attribute(null, '1'),
      },
    });
    const after = surface({
      pkg: {
        A: cls(null, {}, { bases: ['pkg.Other'] }),
        B: { kind: 'alias', target: 'pkg.y.B' },
        C: attribute(null),
        D: cls(null),
        E: attribute(null, '2'),
      },
    });
    const changes = comparePythonSurfaces(before, after);
    expect(majors(changes).sort()).toEqual([
      'pkg.A: no longer derives from pkg.Base',
      'pkg.B: now re-exports pkg.y.B, not pkg.x.B',
      'pkg.C: changed from function to attribute',
      'pkg.D.__init__: constructor changed',
    ]);
    expect(changes).toContainEqual(expect.objectContaining({ symbol: 'pkg.E', bump: 'minor' }));
    expect(changes).toContainEqual(expect.objectContaining({ symbol: 'pkg.A', bump: 'minor' }));
  });

  it('is major for a removed class member', () => {
    const before = sdk(cls(null, { a: attribute(n('str')), m: fn([]) }));
    const after = sdk(cls(null, { a: attribute(n('str')) }));
    expect(majors(comparePythonSurfaces(before, after))).toEqual(['pkg.Body.m: removed']);
  });
});

describe('pythonRoles', () => {
  it('flows through fields and subscripts, and flips at a Protocol', () => {
    const roles = pythonRoles(
      surface({
        pkg: {
          send: fn([param('b', { annotation: { sub: n('list'), args: [n('pkg.Body')] } })], {
            l: [n('pkg.Reply')],
          }),
          Body: cls([param('inner', { annotation: n('pkg.Inner') })]),
          Inner: cls(null),
          Reply: cls(null, { x: attribute(n('pkg.Deep')) }),
          Deep: cls(null),
          Handlers: cls(
            null,
            { h: fn([param('r', { annotation: n('pkg.Req') })], n('pkg.Res')) },
            { protocol: true },
          ),
          Req: cls(null),
          Res: cls(null),
        },
      }),
    );
    const of = (name: string): string[] => [...(roles.get(`pkg.${name}`) ?? [])].sort();
    expect(of('Body')).toEqual(['input']);
    expect(of('Inner')).toEqual(['input']);
    expect(of('Reply')).toEqual(['output']);
    expect(of('Deep')).toEqual(['output']);
    expect(of('Req')).toEqual(['output']);
    expect(of('Res')).toEqual(['input']);
  });
});

describe('compareAnnotations', () => {
  it('treats a missing annotation as a value of its own', () => {
    expect(compareAnnotations(null, null, new Set(['input']))).toBe('same');
    expect(compareAnnotations(null, n('str'), new Set(['input', 'output']))).toBe('incompatible');
  });
});

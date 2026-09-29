import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { compareTypeScriptPackages, removedProperties } from './typescript.js';
import type { SurfaceChange } from './types.js';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Writes a package whose `.` entry point declares `source`, as a generator would emit it. */
async function pkg(source: string, extra: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'speckify-surface-fixture-'));
  roots.push(dir);
  const exports: Record<string, { types: string }> = { '.': { types: './dist/index.d.ts' } };
  for (const subpath of Object.keys(extra)) {
    exports[`./${subpath}`] = { types: `./dist/${subpath}.d.ts` };
  }
  await mkdir(path.join(dir, 'dist'), { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', exports }));
  await writeFile(path.join(dir, 'dist', 'index.d.ts'), source);
  for (const [subpath, text] of Object.entries(extra)) {
    await writeFile(path.join(dir, 'dist', `${subpath}.d.ts`), text);
  }
  return dir;
}

async function compare(
  before: string,
  after: string,
  extraBefore: Record<string, string> = {},
  extraAfter: Record<string, string> = {},
): Promise<SurfaceChange[]> {
  return compareTypeScriptPackages(await pkg(before, extraBefore), await pkg(after, extraAfter));
}

const majors = (changes: readonly SurfaceChange[]): string[] =>
  changes.filter((c) => c.bump === 'major').map((c) => `${c.symbol}: ${c.reason}`);

/** A package whose SDK function takes `Data` and returns `Result`, fixing both directions. */
const sdk = (data: string, result: string, extra = ''): string =>
  [
    `export type Data = ${data};`,
    `export type Result = ${result};`,
    'export declare function call(options: Data): Promise<Result>;',
    extra,
  ].join('\n');

// Each case builds a real TypeScript program, which is slow under coverage and a loaded runner.
describe('compareTypeScriptPackages', { timeout: 60_000 }, () => {
  it('reports nothing for identical packages', async () => {
    expect(
      await compare(sdk('{ a: string }', '{ id: string }'), sdk('{ a: string }', '{ id: string }')),
    ).toEqual([]);
  });

  it('is major for a removed export and minor for an added one', async () => {
    const changes = await compare(
      sdk('{ a: string }', '{ id: string }', 'export type Gone = { x: number };'),
      sdk('{ a: string }', '{ id: string }', 'export type Fresh = { y: number };'),
    );
    expect(majors(changes)).toEqual(['.#Gone: export removed']);
    expect(changes).toContainEqual(
      expect.objectContaining({ symbol: '.#Fresh', bump: 'minor', reason: 'export added' }),
    );
  });

  it('is major for a removed entry point and minor for an added one', async () => {
    const same = sdk('{ a: string }', '{ id: string }');
    const changes = await compare(
      same,
      same,
      { types: 'export type T = string;' },
      { zod: 'export type Z = string;' },
    );
    expect(majors(changes)).toEqual(['./types: entry point removed']);
    expect(changes).toContainEqual(expect.objectContaining({ symbol: './zod', bump: 'minor' }));
  });

  it('input types may widen but not narrow', async () => {
    const widened = await compare(
      sdk("{ c: 'red' | 'green' }", '{ id: string }'),
      sdk("{ c: 'red' | 'green' | 'blue' }", '{ id: string }'),
    );
    expect(majors(widened)).toEqual([]);
    expect(widened.map((c) => c.symbol)).toContain('.#Data');
    const narrowed = await compare(
      sdk("{ c: 'red' | 'green' }", '{ id: string }'),
      sdk("{ c: 'red' }", '{ id: string }'),
    );
    expect(majors(narrowed).join()).toContain('.#Data: is used as input');
  });

  it('output types may narrow but not widen', async () => {
    const narrowed = await compare(
      sdk('{ a: string }', "{ c: 'red' | 'green' }"),
      sdk('{ a: string }', "{ c: 'red' }"),
    );
    expect(majors(narrowed)).toEqual([]);
    const widened = await compare(
      sdk('{ a: string }', "{ c: 'red' }"),
      sdk('{ a: string }', "{ c: 'red' | 'green' }"),
    );
    expect(majors(widened).join()).toContain('.#Result: is used as output');
  });

  it('a type reached from nowhere must stay mutually assignable', async () => {
    const widened = await compare(
      sdk('{ a: string }', '{ id: string }', "export type Loose = 'x';"),
      sdk('{ a: string }', '{ id: string }', "export type Loose = 'x' | 'y';"),
    );
    expect(majors(widened)).toEqual([
      '.#Loose: is used as output and can now produce values it never produced',
    ]);
  });

  it('an optional input property is minor when added and major when removed', async () => {
    const added = await compare(
      sdk('{ a: string }', '{ id: string }'),
      sdk('{ a: string; b?: string }', '{ id: string }'),
    );
    expect(majors(added)).toEqual([]);
    expect(added.map((c) => c.bump)).toContain('minor');
    const removed = await compare(
      sdk('{ a: string; b?: string }', '{ id: string }'),
      sdk('{ a: string }', '{ id: string }'),
    );
    expect(majors(removed)).toEqual(['.#Data: removes .#Data.b']);
  });

  it('a new required input property is major', async () => {
    const changes = await compare(
      sdk('{ a: string }', '{ id: string }'),
      sdk('{ a: string; b: string }', '{ id: string }'),
    );
    expect(majors(changes).join()).toContain('.#Data: is used as input');
  });

  it('a type that became a value, or stopped being one, is major', async () => {
    const changes = await compare(
      sdk(
        '{ a: string }',
        '{ id: string }',
        'export type Both = string; export declare const Both: string;',
      ),
      sdk('{ a: string }', '{ id: string }', 'export declare const Both: string;'),
    );
    expect(majors(changes)).toEqual(['.#Both: is no longer a type']);
  });

  it('judges a zod schema by its output type, in the direction of the matching generated type', async () => {
    const zod = (shape: string): string =>
      `import * as z from 'zod';\nexport declare const zData: z.ZodObject<{ ${shape} }, z.core.$strip>;`;
    const before = sdk("{ c: 'red' | 'green' }", '{ id: string }');
    const after = sdk("{ c: 'red' | 'green' | 'blue' }", '{ id: string }');
    const widened = await compare(
      before,
      after,
      { zod: zod("c: z.ZodEnum<{ red: 'red'; green: 'green' }>") },
      { zod: zod("c: z.ZodEnum<{ red: 'red'; green: 'green'; blue: 'blue' }>") },
    );
    expect(widened).toContainEqual(
      expect.objectContaining({ symbol: './zod#zData', bump: 'minor' }),
    );
    const removed = await compare(
      before,
      before,
      { zod: zod('c: z.ZodString; d: z.ZodString') },
      { zod: zod('c: z.ZodString') },
    );
    expect(majors(removed)).toEqual(['./zod#zData: removes ./zod#zData.d']);
  });

  it('a value may only change so that existing calls still compile', async () => {
    const changes = await compare(
      sdk('{ a: string }', '{ id: string }', 'export declare function f(x: string): void;'),
      sdk(
        '{ a: string }',
        '{ id: string }',
        'export declare function f(x: string, y: string): void;',
      ),
    );
    expect(majors(changes)).toEqual(['.#f: changed so that existing uses no longer compile']);
  });

  it('fails loudly, never as "no change", when a package references an unresolvable module', async () => {
    const broken = sdk(
      '{ a: string }',
      '{ id: string }',
      "import type { Ghost } from 'speckify-does-not-exist';\nexport declare const haunted: Ghost;",
    );
    await expect(compare(broken, broken)).rejects.toThrow(/could not resolve every import/);
  });
});

describe('removedProperties', () => {
  const str = { k: 'prim', name: 'string' } as const;
  const obj = (...names: string[]) =>
    ({
      k: 'obj',
      props: names.map((name) => ({ name, optional: false, readonly: false, type: str })),
      calls: [],
      ctors: [],
      index: [],
    }) as const;

  it('follows a lone object member of a union, and matching references', () => {
    const before = {
      k: 'union',
      members: [obj('a', 'b'), { k: 'prim', name: 'undefined' }],
    } as const;
    const after = { k: 'union', members: [obj('a'), { k: 'prim', name: 'undefined' }] } as const;
    expect(removedProperties(before, after, 'T')).toEqual(['T.b']);
    const ref = (inner: ReturnType<typeof obj>) =>
      ({ k: 'ref', name: 'Array', args: [inner] }) as const;
    expect(removedProperties(ref(obj('a', 'b')), ref(obj('a')), 'T')).toEqual(['T<0>.b']);
    expect(removedProperties({ ...ref(obj('a', 'b')), name: 'Other' }, ref(obj('a')), 'T')).toEqual(
      [],
    );
  });

  it('follows call signature parameters and returns', () => {
    const fn = (param: ReturnType<typeof obj>, returns: ReturnType<typeof obj>) =>
      ({
        k: 'obj',
        props: [],
        calls: [
          { typeParams: 0, params: [{ optional: false, rest: false, type: param }], returns },
        ],
        ctors: [],
        index: [],
      }) as const;
    expect(
      removedProperties(fn(obj('a', 'b'), obj('r', 's')), fn(obj('a'), obj('r')), 'f'),
    ).toEqual(['f(0).b', 'f().s']);
  });

  it('does not guess inside a union with several object members', () => {
    const before = { k: 'union', members: [obj('a'), obj('b')] } as const;
    expect(removedProperties(before, { k: 'union', members: [obj('a')] }, 'T')).toEqual([]);
  });
});

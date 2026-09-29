import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ts from 'typescript';

import { TypeDescriber, type TypeNode } from './typescript-describe.js';
import {
  exportsOf,
  indexRoles,
  readEntryPoints,
  type RoleIndex,
  type TsExport,
} from './typescript-model.js';
import type { Role, SurfaceChange } from './types.js';

const require = createRequire(import.meta.url);

type Side = 'previous' | 'current';

interface SideModel {
  readonly dir: string;
  readonly entries: Map<string, string>;
  exports: Map<string, Map<string, TsExport>>;
  zodOutputs: Map<string, ts.Type>;
  roles: RoleIndex;
}

const SYNTH_FILE = 'surface-check.ts';

const zodAlias = (side: Side, subpath: string, name: string): string =>
  `SpeckifyZodOutput_${side}_${Buffer.from(subpath).toString('hex')}_${name}`;
const exportKey = (subpath: string, name: string): string => `${subpath}#${name}`;

function compilerOptions(currentDir: string): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
    typeRoots: [path.join(currentDir, 'node_modules', '@types')],
  };
}

/** The `import type` specifier for a `.d.ts` file, relative to the synthesised module. */
function importSpecifier(fromDir: string, typesFile: string): string {
  const relative = path.relative(fromDir, typesFile).split(path.sep).join('/');
  return `./${relative.replace(/\.d\.ts$/, '.js')}`;
}

/**
 * Symlinks Speckify's own installed `zod` into `dir/node_modules/zod`, so a
 * generated package's `import * as z from 'zod'` resolves through the
 * program's own `moduleResolution: NodeNext` walk-up regardless of where
 * `dir` sits on disk — a fixture directory, a real generated package that
 * `build.ts` already linked this way, or a downloaded previous package that
 * never went through `build.ts` at all. Idempotent: a link `build.ts` (or an
 * earlier call) already placed there is left alone.
 */
async function linkZod(dir: string, zodDir: string): Promise<void> {
  const target = path.join(dir, 'node_modules', 'zod');
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(zodDir, target, 'dir').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
}

/**
 * The module specifier of an import or re-export declaration — the only
 * import forms a generator emits under `module: NodeNext` — or `undefined`
 * for a declaration with none (a local `export { x }`).
 */
function moduleSpecifierOf(node: ts.Node): ts.Expression | undefined {
  return ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
    ? node.moduleSpecifier
    : undefined;
}

/**
 * Throws when one of `files` imports a module the checker could not
 * resolve, rather than let it silently type-check as `any` — mutually
 * assignable with everything, so the real edit compares as "no change".
 * `getPreEmitDiagnostics` alone misses this on a `.d.ts` entry point under
 * `skipLibCheck`; see surface.md §3.
 */
function assertModulesResolved(program: ts.Program, files: readonly string[], label: string): void {
  const checker = program.getTypeChecker();
  const missing: string[] = [];
  for (const fileName of files) {
    const source = program.getSourceFile(fileName);
    if (source === undefined) continue;
    const visit = (node: ts.Node): void => {
      const specifier = moduleSpecifierOf(node);
      if (specifier !== undefined && checker.getSymbolAtLocation(specifier) === undefined) {
        missing.push(`${fileName}: cannot find module ${specifier.getText()}`);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }
  if (missing.length > 0) {
    throw new Error(
      `surface diff (${label}): could not resolve every import — each would silently ` +
        `compare as \`any\` instead of reporting a real change:\n${missing.join('\n')}`,
    );
  }
}

/**
 * The synthesised module: `z.output<typeof schema>` for each zod schema the
 * first pass found. See surface.md §3.
 */
function synthesise(
  synthDir: string,
  sides: Record<Side, SideModel>,
  zodExports: string[][],
): string {
  const lines = ["import type { output } from 'zod';"];
  for (const [side, subpath, name] of zodExports as [Side, string, string][]) {
    const file = sides[side].entries.get(subpath) ?? '';
    const ns = `N_${zodAlias(side, subpath, name)}`;
    lines.push(`import type * as ${ns} from '${importSpecifier(synthDir, file)}';`);
    lines.push(`export type ${zodAlias(side, subpath, name)} = output<typeof ${ns}.${name}>;`);
  }
  return lines.join('\n') + '\n';
}

function synthExports(program: ts.Program, synthPath: string): Map<string, ts.Type> {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(synthPath);
  const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  const result = new Map<string, ts.Type>();
  for (const symbol of moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol)) {
    result.set(symbol.name, checker.getDeclaredTypeOfSymbol(symbol));
  }
  return result;
}

function loadExports(program: ts.Program, model: SideModel): void {
  model.exports = new Map(
    [...model.entries].map(([subpath, file]) => [subpath, exportsOf(program, file)]),
  );
}

/** Reloads each side's exports in `program`, attaches zod output types and indexes roles. */
function finishModels(
  program: ts.Program,
  sides: Record<Side, SideModel>,
  synth: Map<string, ts.Type>,
  zodExports: string[][],
): void {
  const checker = program.getTypeChecker();
  for (const side of ['previous', 'current'] as const) {
    const model = sides[side];
    loadExports(program, model);
    for (const [s, subpath, name] of zodExports as [Side, string, string][]) {
      const output = synth.get(zodAlias(s, subpath, name));
      if (s === side && output !== undefined)
        model.zodOutputs.set(exportKey(subpath, name), output);
    }
    const seeds = [...model.exports].flatMap(([subpath, exported]) =>
      [...exported.values()].flatMap((item) =>
        item.valueSide !== undefined && !model.zodOutputs.has(exportKey(subpath, item.name))
          ? [item.valueSide]
          : [],
      ),
    );
    model.roles = indexRoles(checker, seeds, [model.dir]);
  }
}

/** Loads both packages into one program (a second pass only for zod schemas; see surface.md §3). */
async function buildModels(
  previousDir: string,
  currentDir: string,
  synthDir: string,
): Promise<{ program: ts.Program; sides: Record<Side, SideModel> }> {
  const empty = (dir: string, entries: Map<string, string>): SideModel => ({
    dir,
    entries,
    exports: new Map(),
    zodOutputs: new Map(),
    roles: { bySymbol: new Map(), byShape: new Map() },
  });
  const sides: Record<Side, SideModel> = {
    previous: empty(previousDir, await readEntryPoints(previousDir)),
    current: empty(currentDir, await readEntryPoints(currentDir)),
  };
  const zodDir = await realpath(path.dirname(require.resolve('zod/package.json')));
  await Promise.all([linkZod(previousDir, zodDir), linkZod(currentDir, zodDir)]);
  const entryFiles = [...sides.previous.entries.values(), ...sides.current.entries.values()];
  const options = compilerOptions(currentDir);
  const first = ts.createProgram(entryFiles, options);
  assertModulesResolved(first, entryFiles, 'first pass');
  const fromZod = (type: ts.Type): boolean =>
    (type.aliasSymbol ?? type.getSymbol())?.declarations?.some((declaration) =>
      declaration.getSourceFile().fileName.startsWith(zodDir + path.sep),
    ) === true;
  const zodExports: string[][] = [];
  for (const side of ['previous', 'current'] as const) {
    loadExports(first, sides[side]);
    for (const [subpath, exported] of sides[side].exports) {
      for (const item of exported.values()) {
        if (item.valueSide !== undefined && fromZod(item.valueSide)) {
          zodExports.push([side, subpath, item.name]);
        }
      }
    }
  }
  if (zodExports.length === 0) {
    finishModels(first, sides, new Map(), []);
    return { program: first, sides };
  }

  const synthPath = path.join(synthDir, SYNTH_FILE);
  await writeFile(synthPath, synthesise(synthDir, sides, zodExports));
  const program = ts.createProgram([...entryFiles, synthPath], options, undefined, first);
  assertModulesResolved(program, [synthPath], 'zod second pass');
  finishModels(program, sides, synthExports(program, synthPath), zodExports);
  return { program, sides };
}

/** Property paths present in `previous` and missing from `current`; see surface.md §3. */
export function removedProperties(previous: TypeNode, current: TypeNode, at: string): string[] {
  if (previous.k === 'obj' && current.k === 'obj') {
    const removed: string[] = [];
    for (const prop of previous.props) {
      const match = current.props.find((candidate) => candidate.name === prop.name);
      if (match === undefined) removed.push(`${at}.${prop.name}`);
      else removed.push(...removedProperties(prop.type, match.type, `${at}.${prop.name}`));
    }
    previous.calls.forEach((sig, index) => {
      const other = current.calls[index];
      if (other === undefined) return;
      sig.params.forEach((param, i) => {
        const otherParam = other.params[i];
        if (otherParam !== undefined) {
          removed.push(...removedProperties(param.type, otherParam.type, `${at}(${String(i)})`));
        }
      });
      removed.push(...removedProperties(sig.returns, other.returns, `${at}()`));
    });
    return removed;
  }
  if (previous.k === 'union' && current.k === 'union') {
    const objects = (node: typeof previous): TypeNode[] =>
      node.members.filter((member) => member.k === 'obj');
    const [before] = objects(previous);
    const [after] = objects(current);
    if (objects(previous).length === 1 && objects(current).length === 1 && before && after) {
      return removedProperties(before, after, at);
    }
    return [];
  }
  if (previous.k === 'ref' && current.k === 'ref' && previous.name === current.name) {
    return previous.args.flatMap((arg, index) => {
      const other = current.args[index];
      return other === undefined ? [] : removedProperties(arg, other, `${at}<${String(index)}>`);
    });
  }
  return [];
}

function rolesFor(previous: Set<Role> | undefined, current: Set<Role> | undefined): Set<Role> {
  const roles = new Set<Role>([...(previous ?? []), ...(current ?? [])]);
  return roles.size === 0 ? new Set<Role>(['input', 'output']) : roles;
}

interface Comparison {
  readonly checker: ts.TypeChecker;
  readonly describer: TypeDescriber;
}

/** The change for one pair of types in the given roles, or undefined when identical. */
function compareTypes(
  context: Comparison,
  symbol: string,
  previous: ts.Type,
  current: ts.Type,
  roles: Set<Role>,
  kind: 'type' | 'value' = 'type',
): SurfaceChange | undefined {
  const { checker, describer } = context;
  const before = describer.describe(previous);
  const after = describer.describe(current);
  if (JSON.stringify(before) === JSON.stringify(after)) return undefined;
  const removed = removedProperties(before, after, symbol);
  if (removed.length > 0) {
    return change(symbol, 'major', `removes ${removed.join(', ')}`);
  }
  if (roles.has('input') && !checker.isTypeAssignableTo(previous, current)) {
    return change(
      symbol,
      'major',
      'is used as input and no longer accepts every value it accepted',
    );
  }
  if (roles.has('output') && !checker.isTypeAssignableTo(current, previous)) {
    const reason =
      kind === 'value'
        ? 'changed so that existing uses no longer compile'
        : 'is used as output and can now produce values it never produced';
    return change(symbol, 'major', reason);
  }
  return change(symbol, 'minor', 'changed compatibly');
}

const change = (symbol: string, bump: 'minor' | 'major', reason: string): SurfaceChange => ({
  language: 'typescript',
  symbol,
  bump,
  reason,
});

function compareExport(
  context: Comparison,
  sides: Record<Side, SideModel>,
  subpath: string,
  previous: TsExport,
  current: TsExport,
): SurfaceChange[] {
  const key = exportKey(subpath, previous.name);
  const changes: SurfaceChange[] = [];
  const zodBefore = sides.previous.zodOutputs.get(key);
  const zodAfter = sides.current.zodOutputs.get(key);
  if ((previous.typeSide === undefined) !== (current.typeSide === undefined)) {
    const bump = previous.typeSide === undefined ? 'minor' : 'major';
    changes.push(
      change(key, bump, bump === 'major' ? 'is no longer a type' : 'is now also a type'),
    );
  }
  if ((previous.valueSide === undefined) !== (current.valueSide === undefined)) {
    const bump = previous.valueSide === undefined ? 'minor' : 'major';
    changes.push(
      change(key, bump, bump === 'major' ? 'is no longer a value' : 'is now also a value'),
    );
  }
  if (previous.typeSide !== undefined && current.typeSide !== undefined) {
    const roles = rolesFor(
      sides.previous.roles.bySymbol.get(previous.symbol),
      sides.current.roles.bySymbol.get(current.symbol),
    );
    const found = compareTypes(context, key, previous.typeSide, current.typeSide, roles);
    if (found !== undefined) changes.push(found);
  }
  if (zodBefore !== undefined && zodAfter !== undefined) {
    const shape = (side: Side, type: ts.Type): Set<Role> | undefined =>
      sides[side].roles.byShape.get(JSON.stringify(context.describer.describe(type)));
    const roles = rolesFor(shape('previous', zodBefore), shape('current', zodAfter));
    const found = compareTypes(context, key, zodBefore, zodAfter, roles);
    if (found !== undefined) changes.push(found);
  } else if (previous.valueSide !== undefined && current.valueSide !== undefined) {
    const outputOnly = new Set<Role>(['output']);
    const found = compareTypes(
      context,
      key,
      previous.valueSide,
      current.valueSide,
      outputOnly,
      'value',
    );
    if (found !== undefined) changes.push(found);
  }
  return changes;
}

/**
 * Compares two generated TypeScript packages' public surfaces through one
 * TypeScript program and its checker; see surface.md §3.
 */
export async function compareTypeScriptPackages(
  previousDir: string,
  currentDir: string,
): Promise<SurfaceChange[]> {
  const synthDir = await realpath(await mkdtemp(path.join(tmpdir(), 'speckify-surface-ts-')));
  try {
    await writeFile(path.join(synthDir, 'package.json'), '{ "type": "module" }\n');
    await linkZod(synthDir, await realpath(path.dirname(require.resolve('zod/package.json'))));
    const { program, sides } = await buildModels(
      await realpath(previousDir),
      await realpath(currentDir),
      synthDir,
    );
    const checker = program.getTypeChecker();
    const context: Comparison = { checker, describer: new TypeDescriber(checker) };
    const changes: SurfaceChange[] = [];
    for (const subpath of sides.previous.entries.keys()) {
      if (!sides.current.entries.has(subpath)) {
        changes.push(change(subpath, 'major', 'entry point removed'));
      }
    }
    for (const [subpath, current] of sides.current.exports) {
      const previous = sides.previous.exports.get(subpath);
      if (previous === undefined) {
        changes.push(change(subpath, 'minor', 'entry point added'));
        continue;
      }
      for (const [name, before] of previous) {
        const after = current.get(name);
        if (after === undefined) {
          changes.push(change(exportKey(subpath, name), 'major', 'export removed'));
        } else {
          changes.push(...compareExport(context, sides, subpath, before, after));
        }
      }
      for (const name of current.keys()) {
        if (!previous.has(name))
          changes.push(change(exportKey(subpath, name), 'minor', 'export added'));
      }
    }
    return changes;
  } finally {
    await rm(synthDir, { recursive: true, force: true });
  }
}

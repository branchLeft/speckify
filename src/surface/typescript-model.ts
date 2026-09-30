import { readFile } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';

import { TypeDescriber } from './typescript-describe.js';
import type { Role } from './types.js';

/** One exported symbol of one entry point, with the checker types consumers see. */
export interface TsExport {
  readonly name: string;
  readonly symbol: ts.Symbol;
  /** The declared type, when the symbol is a type or interface. */
  readonly typeSide: ts.Type | undefined;
  /** The value's type, when the symbol is a value (function, const, class). */
  readonly valueSide: ts.Type | undefined;
}

/** A package's `exports` subpath to the absolute path of its `types` file. */
export async function readEntryPoints(packageDir: string): Promise<Map<string, string>> {
  const raw = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8')) as {
    exports?: Record<string, { types?: unknown }>;
  };
  const entries = new Map<string, string>();
  for (const [subpath, target] of Object.entries(raw.exports ?? {})) {
    if (typeof target.types === 'string') {
      entries.set(subpath, path.join(packageDir, target.types));
    }
  }
  return entries;
}

/** The exports of one entry point's declaration file, aliases resolved. */
export function exportsOf(program: ts.Program, typesFile: string): Map<string, TsExport> {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(typesFile);
  const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  const result = new Map<string, TsExport>();
  if (moduleSymbol === undefined) return result;
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol =
      (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
    const isType = (symbol.flags & (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface)) !== 0;
    const isValue = (symbol.flags & ts.SymbolFlags.Value) !== 0;
    result.set(exported.name, {
      name: exported.name,
      symbol,
      typeSide: isType ? checker.getDeclaredTypeOfSymbol(symbol) : undefined,
      valueSide: isValue ? checker.getTypeOfSymbol(symbol) : undefined,
    });
  }
  return result;
}

/** Roles found for symbols and for anonymous object shapes; see surface.md §3. */
export interface RoleIndex {
  readonly bySymbol: Map<ts.Symbol, Set<Role>>;
  readonly byShape: Map<string, Set<Role>>;
}

const flip = (role: Role): Role => (role === 'input' ? 'output' : 'input');

function addRole<K>(map: Map<K, Set<Role>>, key: K, role: Role): void {
  const roles = map.get(key) ?? new Set<Role>();
  roles.add(role);
  map.set(key, roles);
}

/**
 * Walks every type reachable from `seeds`, recording the direction each
 * named symbol and anonymous shape is reached in. A value is output: the
 * consumer receives it, so its parameters are input.
 */
export function indexRoles(
  checker: ts.TypeChecker,
  seeds: readonly ts.Type[],
  packageDirs: readonly string[],
): RoleIndex {
  const index: RoleIndex = { bySymbol: new Map(), byShape: new Map() };
  const describer = new TypeDescriber(checker);
  const visited = new Map<ts.Type, Set<Role>>();
  const inPackage = (symbol: ts.Symbol | undefined): boolean =>
    symbol?.declarations?.some((declaration) => {
      const file = declaration.getSourceFile().fileName;
      return packageDirs.some((dir) => file.startsWith(dir + path.sep));
    }) === true;

  const walk = (type: ts.Type, role: Role): void => {
    if (visited.get(type)?.has(role) === true) return;
    addRole(visited, type, role);
    if (type.aliasSymbol !== undefined) {
      addRole(index.bySymbol, type.aliasSymbol, role);
      for (const arg of type.aliasTypeArguments ?? []) walk(arg, role);
      if (!inPackage(type.aliasSymbol)) return;
    }
    if (type.isUnionOrIntersection()) {
      for (const member of type.types) walk(member, role);
      return;
    }
    if ((type.flags & ts.TypeFlags.Object) === 0) return;
    const symbol = type.getSymbol();
    if (symbol !== undefined) addRole(index.bySymbol, symbol, role);
    if (((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0) {
      for (const arg of checker.getTypeArguments(type as ts.TypeReference)) walk(arg, role);
    }
    if (!inPackage(symbol)) return;
    addRole(index.byShape, JSON.stringify(describer.describe(type)), role);
    for (const prop of checker.getPropertiesOfType(type)) {
      walk(checker.getTypeOfSymbol(prop), role);
    }
    for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct]) {
      for (const signature of checker.getSignaturesOfType(type, kind)) {
        for (const param of signature.getParameters()) {
          walk(checker.getTypeOfSymbol(param), flip(role));
        }
        walk(signature.getReturnType(), role);
      }
    }
    for (const info of checker.getIndexInfosOfType(type)) walk(info.type, role);
  };

  for (const seed of seeds) walk(seed, 'output');
  return index;
}

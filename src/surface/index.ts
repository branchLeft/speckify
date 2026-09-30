import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BundledSpec } from '../bundle/index.js';
import { generatePythonPackage, importNameFor } from '../codegen/python/index.js';
import type { UvRunnerDeps } from '../codegen/python/uv.js';
import { generateTypeScriptPackage } from '../codegen/typescript/index.js';
import { comparePythonSurfaces, extractPythonSurface } from './python.js';
import { reportOf, type SurfaceChange, type SurfaceReport } from './types.js';
import { compareTypeScriptPackages } from './typescript.js';

export { reportOf, type SurfaceChange, type SurfaceReport } from './types.js';

/** Which halves of which languages a contract generates. */
export interface SurfaceTargets {
  readonly typescript?: { readonly client: boolean; readonly server: boolean } | undefined;
  readonly python?: { readonly client: boolean; readonly server: boolean } | undefined;
}

export interface CompareSurfacesInput {
  readonly previousSpec: string;
  readonly currentSpec: string;
  readonly targets: SurfaceTargets;
  /** The `python/` toolchain directory; required when `targets.python` is set. */
  readonly toolchainDir?: string | undefined;
  readonly uvDeps?: UvRunnerDeps | undefined;
}

/** The generated packages' name: the same on both sides, so it never shows as a change. */
const SURFACE_PACKAGE = 'speckify-surface';

/** The server-only subpath hey-api/openapi-python-client-style TS packages export. */
const TS_SERVER_SUBPATH = './server';

/**
 * True for a change under the server-only surface: TS's `./server` entry
 * point, or Python's `<importName>.server` module tree. Everything else is
 * the client surface (TS client/types/zod entry points; Python client +
 * models) — see surface.md §1.
 */
function isServerChange(change: SurfaceChange, pythonImportName: string): boolean {
  if (change.language === 'typescript') {
    return change.symbol === TS_SERVER_SUBPATH || change.symbol.startsWith(`${TS_SERVER_SUBPATH}#`);
  }
  const prefix = `${pythonImportName}.server`;
  return change.symbol === prefix || change.symbol.startsWith(`${prefix}.`);
}

/** Splits `changes` into the client surface (drives the bump) and the server-only surface. */
function splitByScope(
  changes: readonly SurfaceChange[],
  pythonImportName: string,
): { client: SurfaceChange[]; server: SurfaceChange[] } {
  const client: SurfaceChange[] = [];
  const server: SurfaceChange[] = [];
  for (const change of changes) {
    (isServerChange(change, pythonImportName) ? server : client).push(change);
  }
  return { client, server };
}

interface Generated {
  readonly typescript?: string;
  readonly python?: string;
}

async function generate(
  spec: string,
  dir: string,
  input: CompareSurfacesInput,
): Promise<Generated> {
  const { typescript, python } = input.targets;
  const common = {
    packageName: SURFACE_PACKAGE,
    version: '0.0.0',
    changelog: '',
    speckifyVersion: '0.0.0',
  };
  const [ts, py] = await Promise.all([
    typescript === undefined
      ? undefined
      : generateTypeScriptPackage({
          ...common,
          client: typescript.client,
          server: typescript.server,
          bundledSpec: JSON.parse(spec) as BundledSpec,
          outDir: join(dir, 'typescript'),
        }).then(() => join(dir, 'typescript')),
    python === undefined
      ? undefined
      : generatePythonPackage(
          { ...common, client: python.client, server: python.server, bundledSpec: spec },
          { projectDir: join(dir, 'python'), toolchainDir: input.toolchainDir ?? '' },
          input.uvDeps,
        ).then(() => join(dir, 'python', 'src')),
  ]);
  return {
    ...(ts === undefined ? {} : { typescript: ts }),
    ...(py === undefined ? {} : { python: py }),
  };
}

/**
 * Generates the previous and current specs with the current toolchain and
 * compares the packages' public surfaces per language. See surface.md.
 */
export async function compareGeneratedSurfaces(
  input: CompareSurfacesInput,
): Promise<SurfaceReport> {
  if (input.targets.python !== undefined && input.toolchainDir === undefined) {
    throw new Error('the surface diff needs the Python toolchain directory for a Python target');
  }
  // One spec through one pinned toolchain generates one surface (surface.md §1).
  if (input.previousSpec === input.currentSpec) return reportOf([]);
  const root = await mkdtemp(join(tmpdir(), 'speckify-surface-'));
  try {
    const [previous, current] = await Promise.all([
      generate(input.previousSpec, join(root, 'previous'), input),
      generate(input.currentSpec, join(root, 'current'), input),
    ]);
    const [tsAll, pyAll] = await Promise.all([
      previous.typescript !== undefined && current.typescript !== undefined
        ? compareTypeScriptPackages(previous.typescript, current.typescript)
        : [],
      previous.python !== undefined && current.python !== undefined
        ? comparePythonPackages(previous.python, current.python, input)
        : [],
    ]);
    const pythonImportName = importNameFor(SURFACE_PACKAGE);
    const ts = splitByScope(tsAll, pythonImportName);
    const py = splitByScope(pyAll, pythonImportName);
    return reportOf([...ts.client, ...py.client], [...ts.server, ...py.server]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function comparePythonPackages(
  previousSrc: string,
  currentSrc: string,
  input: CompareSurfacesInput,
): Promise<SurfaceChange[]> {
  const importName = importNameFor(SURFACE_PACKAGE);
  const toolchainDir = input.toolchainDir ?? '';
  const [previous, current] = await Promise.all([
    extractPythonSurface(previousSrc, importName, toolchainDir, input.uvDeps),
    extractPythonSurface(currentSrc, importName, toolchainDir, input.uvDeps),
  ]);
  return comparePythonSurfaces(previous, current);
}

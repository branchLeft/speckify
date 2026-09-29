import { join } from 'node:path';

import type { BundledSpec } from './bundle/index.js';
import type { Contract } from './config/index.js';
import { generateTypeScriptPackage } from './codegen/typescript/index.js';
import { buildPythonPackage } from './codegen/python/index.js';
import { renderChangelogMarkdown, type ContractPlan } from './plan.js';

/** The default output root a generated contract's packages land under: `.speckify/out/<contract>/<lang>`. */
export const DEFAULT_BUILD_OUT_DIR = '.speckify/out';

export interface BuildContractOptions {
  /** The contract as declared in speckify.yaml: which languages/targets it wants generated. */
  contract: Contract;
  /** Speckify's own version, stamped into each generated package for support/debugging. */
  speckifyVersion: string;
  /** The `python/` toolchain directory (containing `pyproject.toml` + `uv.lock`). Required only when `contract.python` is set. */
  toolchainDir?: string;
  /** Base output directory each contract's `<lang>` subdirectory is written under. @default DEFAULT_BUILD_OUT_DIR */
  outDir?: string;
}

export interface BuildContractResult {
  /** Present when `contract.typescript` was set: the generated, built npm package's directory. */
  typescript?: { dir: string };
  /** Present when `contract.python` was set: the directory `uv build` wrote the wheel and sdist into. */
  python?: { distDir: string };
}

/**
 * Generates and builds every language a contract's config requests, at the
 * version `plan` computed, with the changelog rendered from `plan`'s
 * classified diff and the bundled spec `plan` already stamped with that
 * version.
 *
 * This is the one seam `speckify build` and the ship agent's `speckify
 * publish` both call: `build` stops here, `publish` takes this result's
 * directories and pushes them to the registries.
 */
export async function buildContract(
  plan: ContractPlan,
  options: BuildContractOptions,
): Promise<BuildContractResult> {
  const { contract } = options;
  const outDir = options.outDir ?? DEFAULT_BUILD_OUT_DIR;
  const changelog = renderChangelogMarkdown(plan.changes);
  const result: BuildContractResult = {};

  if (contract.typescript !== undefined) {
    const dir = join(outDir, contract.name, 'typescript');
    await generateTypeScriptPackage({
      bundledSpec: JSON.parse(plan.bundledSpec) as BundledSpec,
      packageName: contract.typescript.package,
      version: plan.version,
      client: contract.typescript.client,
      server: contract.typescript.server,
      changelog,
      speckifyVersion: options.speckifyVersion,
      outDir: dir,
    });
    result.typescript = { dir };
  }

  if (contract.python !== undefined) {
    if (options.toolchainDir === undefined) {
      throw new Error(
        `contract "${contract.name}" requests a Python target but no Python toolchain directory was provided`,
      );
    }
    const projectDir = join(outDir, contract.name, 'python');
    await buildPythonPackage(
      {
        bundledSpec: plan.bundledSpec,
        packageName: contract.python.package,
        version: plan.version,
        client: contract.python.client,
        server: contract.python.server,
        changelog,
        speckifyVersion: options.speckifyVersion,
      },
      { projectDir, toolchainDir: options.toolchainDir },
    );
    result.python = { distDir: join(projectDir, 'dist') };
  }

  return result;
}

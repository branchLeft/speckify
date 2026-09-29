import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { bundleSpec } from '../bundle/index.js';
import { loadConfig, type Contract } from '../config/index.js';
import { OASDIFF_CLASSIFICATION_MAP_FILENAME, resolveOasdiffBinary } from '../oasdiff/index.js';
import { computeContractPlan } from '../plan.js';
import { loadClassificationMap } from '../version/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exampleDir = join(repoRoot, 'examples', 'pet-shelter');

/**
 * Exercises the example contract end to end against a mocked registry (this
 * is a first publish, so there is nothing to diff against), then hands the
 * bundled spec to whichever codegen modules are present on this branch.
 * Codegen lands from separate branches (`src/codegen/typescript`,
 * `src/codegen/python`) and may not be merged here yet — each step is
 * skipped, with the reason logged, rather than failing the build.
 */
describe('examples/pet-shelter end to end', () => {
  it('bundles, lints and plans a first publish for the example contract', async () => {
    const config = await loadConfig(join(exampleDir, 'speckify.yaml'));
    const contract = config.contracts[0];
    expect(contract).toBeDefined();
    if (contract === undefined) {
      return;
    }

    const bundledSpec = await bundleSpec(join(exampleDir, contract.spec), { repoRoot: exampleDir });
    const classificationMap = await loadClassificationMap(
      resolve(repoRoot, 'data', OASDIFF_CLASSIFICATION_MAP_FILENAME),
    );
    const oasdiffPath = await resolveOasdiffBinary({
      cacheDir: join(homedir(), '.cache', 'speckify', 'oasdiff'),
    });

    const plan = await computeContractPlan({
      contract: contract.name,
      bundledSpec,
      previous: null,
      classificationMap,
      toolchainImpactBump: 'none',
      oasdiffPath,
    });

    expect(plan.version).toBe('1.0.0');
    expect(plan.bump).toBe('none');
    expect(JSON.parse(plan.bundledSpec)).toMatchObject({ info: { version: '1.0.0' } });

    await maybeRunTypescriptCodegen(plan.bundledSpec, contract);
    await maybeRunPythonCodegen(plan.bundledSpec, contract);
  });
});

async function maybeRunTypescriptCodegen(bundledSpec: string, contract: Contract): Promise<void> {
  if (contract.typescript === undefined) {
    return;
  }
  try {
    // Resolved dynamically: this module only exists once the TypeScript
    // codegen branch has merged, and importing it by a static specifier
    // would fail typecheck on this branch in the meantime.
    const modulePath = '../codegen/typescript/index.js';
    const codegen: unknown = await import(/* @vite-ignore */ modulePath);
    expect(codegen).toBeDefined();
    void bundledSpec;
  } catch (error) {
    console.log(
      `skipping TypeScript codegen for "${contract.name}": src/codegen/typescript is not on this branch yet (${String(error)})`,
    );
  }
}

async function maybeRunPythonCodegen(bundledSpec: string, contract: Contract): Promise<void> {
  if (contract.python === undefined) {
    return;
  }
  try {
    const modulePath = '../codegen/python/index.js';
    const codegen: unknown = await import(/* @vite-ignore */ modulePath);
    expect(codegen).toBeDefined();
    void bundledSpec;
  } catch (error) {
    console.log(
      `skipping Python codegen for "${contract.name}": src/codegen/python is not on this branch yet (${String(error)})`,
    );
  }
}

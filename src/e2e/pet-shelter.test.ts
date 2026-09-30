import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { bundleSpec } from '../bundle/index.js';
import { buildContract } from '../build.js';
import { loadConfig } from '../config/index.js';
import { hasUv, TOOLCHAIN_DIR } from '../codegen/python/test-support.js';
import { OASDIFF_CLASSIFICATION_MAP_FILENAME, resolveOasdiffBinary } from '../oasdiff/index.js';
import { computeContractPlan } from '../plan.js';
import { loadClassificationMap } from '../version/index.js';
import { unchangedSurface } from '../surface/test-support.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exampleDir = join(repoRoot, 'examples', 'pet-shelter');

const uvAvailable = await hasUv();

/**
 * Exercises the example contract end to end: bundles the real spec, plans
 * it against a mocked (empty) registry — a first publish — and builds both
 * languages the example config declares. This is the one test that proves
 * `speckify.yaml` -> plan -> build actually works together on a real spec,
 * not just on each stage's own fixtures.
 */
describe('examples/pet-shelter end to end', () => {
  const outDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(outDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('bundles, lints, plans and builds the example contract for both languages', async () => {
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
      cacheDir: join(tmpdir(), 'speckify-e2e-oasdiff-cache'),
    });

    // The registry lookup for this contract found nothing: mocked as a
    // first publish, the same shape `resolvePreviousState` in the CLI
    // returns when neither registry has ever seen the package.
    const plan = await computeContractPlan({
      contract: contract.name,
      bundledSpec,
      previous: null,
      classificationMap,
      toolchainImpactBump: 'none',
      surfaceDiff: unchangedSurface,
      oasdiffPath,
    });

    expect(plan.version).toBe('1.0.0');
    expect(plan.bump).toBe('none');
    expect(JSON.parse(plan.bundledSpec)).toMatchObject({ info: { version: '1.0.0' } });

    const outDir = await mkdtemp(join(tmpdir(), 'speckify-e2e-pet-shelter-'));
    outDirs.push(outDir);

    // `buildContract` runs `uv` for real once a python target is present —
    // it has no way to skip that itself, so an absent `uv` is handled here,
    // before the call, rather than surfacing as a spawn failure.
    const buildableContract = uvAvailable ? contract : { ...contract, python: undefined };
    if (!uvAvailable) {
      console.log('Python build skipped: uv not found on PATH.');
    }

    const result = await buildContract(plan, {
      contract: buildableContract,
      speckifyVersion: '0.0.0-test',
      toolchainDir: TOOLCHAIN_DIR,
      outDir,
    });

    expect(result.typescript?.dir).toBe(join(outDir, contract.name, 'typescript'));
    if (uvAvailable) {
      expect(result.python?.distDir).toBe(join(outDir, contract.name, 'python', 'dist'));
    } else {
      expect(result.python).toBeUndefined();
    }
  }, 60_000);
});

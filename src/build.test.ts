import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { PLACEHOLDER_VERSION } from './bundle/index.js';
import { toCanonicalJson } from './bundle/canonical-json.js';
import type { Contract } from './config/index.js';
import { computeContractPlan } from './plan.js';
import { buildContract } from './build.js';
import { hasUv, TOOLCHAIN_DIR } from './codegen/python/test-support.js';
import { resolveUv } from './codegen/python/uv.js';

// Shared between the TS and Python codegen fixture directories already,
// and already proven end to end for both languages (see
// codegen/python/index.test.ts): one POST operation with a discriminated
// oneOf request/response body, small enough to build a whole client+server
// for both languages quickly.
const FIXTURE_PATH = fileURLToPath(
  new URL('../test/fixtures/codegen-ts/b-oneof-discriminator.bundled.yaml', import.meta.url),
);

/**
 * Re-serialises the fixture exactly the way `bundleSpec` would: canonical,
 * key-sorted JSON with the placeholder version stamped in. The fixture is
 * already bundled (no external `$ref`s left to inline), so this is the
 * whole of what `bundleSpec` would do to it.
 */
function loadPlaceholderBundledSpec(): string {
  const document = parseYaml(readFileSync(FIXTURE_PATH, 'utf8')) as { info: { version: unknown } };
  document.info.version = PLACEHOLDER_VERSION;
  return toCanonicalJson(document);
}

function typecheckStrictConsumer(entryFile: string): string[] {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: false,
    esModuleInterop: true,
    noEmit: true,
  };
  const program = ts.createProgram([entryFile], compilerOptions);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  const host: ts.FormatDiagnosticsHost = {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (f) => f,
    getNewLine: () => ts.sys.newLine,
  };
  return diagnostics.map((d) => ts.formatDiagnostic(d, host).trim());
}

async function findWheel(distDir: string): Promise<string> {
  const entries = await readdir(distDir);
  const wheel = entries.find((name) => name.endsWith('.whl'));
  if (!wheel) {
    throw new Error(`no wheel found in ${distDir}`);
  }
  return path.join(distDir, wheel);
}

/** Runs `python -c <code>` inside an ephemeral uv environment with `wheelPath` installed. */
async function runPythonWithWheel(wheelPath: string, code: string): Promise<string> {
  const uvPath = await resolveUv();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(uvPath, [
      'run',
      '--no-project',
      '--python',
      '3.13',
      '--with',
      wheelPath,
      'python',
      '-c',
      code,
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`python -c failed (exit ${String(exitCode)}):\n${stderr}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

const uvAvailable = await hasUv();

describe('buildContract (end-to-end: plan through a mocked first-publish registry, then build)', () => {
  const outDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(outDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('generates and builds the TypeScript package for a first publish, and its dist types typecheck in a strict consumer', async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), 'speckify-build-e2e-'));
    outDirs.push(outDir);

    const contract: Contract = {
      name: 'e2e-fixture',
      spec: 'unused.yaml',
      typescript: { package: '@speckify-fixtures/e2e-build', client: true, server: true },
    };

    // The registry lookup for this contract found nothing: it's never been
    // published before, so the plan diffs against nothing and always
    // resolves to the first published version.
    const plan = await computeContractPlan({
      contract: contract.name,
      bundledSpec: loadPlaceholderBundledSpec(),
      previous: null,
      classificationMap: {},
      coveredKeywords: new Set<string>(),
      toolchainImpactBump: 'none',
      oasdiffPath: '',
    });
    expect(plan.previousVersion).toBeNull();
    expect(plan.version).toBe('1.0.0');

    const result = await buildContract(plan, {
      contract,
      speckifyVersion: '0.0.0-test',
      outDir,
    });

    if (!result.typescript) {
      throw new Error('expected a typescript build result');
    }
    expect(result.typescript.dir).toBe(path.join(outDir, 'e2e-fixture', 'typescript'));

    // A consumer nested inside the package's own tree resolves the package
    // by name via Node's self-reference resolution, the same way an
    // installed dependency would resolve for a real consumer.
    const consumerDir = path.join(result.typescript.dir, 'consumer-check');
    await mkdir(consumerDir, { recursive: true });
    const consumerFile = path.join(consumerDir, 'consumer.ts');
    await writeFile(
      consumerFile,
      [
        "import { createPet } from '@speckify-fixtures/e2e-build';",
        "import type { CreatePetResponse } from '@speckify-fixtures/e2e-build/types';",
        "import { createServer, type Handlers } from '@speckify-fixtures/e2e-build/server';",
        '',
        'type CreatePetArgs = Parameters<typeof createPet>[0];',
        'export function describeClientCall(args: CreatePetArgs): string {',
        '  return typeof args;',
        '}',
        '',
        'const handlers: Handlers = {',
        '  async createPet() {',
        "    const body: CreatePetResponse = { petType: 'cat', meowVolume: 5 };",
        '    return { status: 201, body };',
        '  },',
        '};',
        '',
        'export const listener = createServer(handlers);',
        '',
      ].join('\n'),
    );

    expect(typecheckStrictConsumer(consumerFile)).toEqual([]);
  }, 30_000);

  it.skipIf(!uvAvailable)(
    'generates and builds the Python wheel for a first publish, and it installs and imports in a clean uv environment',
    async () => {
      const outDir = await mkdtemp(path.join(os.tmpdir(), 'speckify-build-e2e-py-'));
      outDirs.push(outDir);

      const contract: Contract = {
        name: 'e2e-fixture-py',
        spec: 'unused.yaml',
        python: { package: 'speckify-fixture-e2e-build', client: true, server: true },
      };

      const plan = await computeContractPlan({
        contract: contract.name,
        bundledSpec: loadPlaceholderBundledSpec(),
        previous: null,
        classificationMap: {},
        coveredKeywords: new Set<string>(),
        toolchainImpactBump: 'none',
        oasdiffPath: '',
      });
      expect(plan.version).toBe('1.0.0');

      const result = await buildContract(plan, {
        contract,
        speckifyVersion: '0.0.0-test',
        toolchainDir: TOOLCHAIN_DIR,
        outDir,
      });

      if (!result.python) {
        throw new Error('expected a python build result');
      }
      expect(result.python.distDir).toBe(path.join(outDir, 'e2e-fixture-py', 'python', 'dist'));

      const wheelPath = await findWheel(result.python.distDir);
      const output = await runPythonWithWheel(
        wheelPath,
        [
          'import speckify_fixture_e2e_build',
          'import speckify_fixture_e2e_build.models as models',
          'import speckify_fixture_e2e_build.client as client',
          'assert hasattr(models, "Cat")',
          'assert hasattr(models, "Dog")',
          'print("IMPORT_OK")',
        ].join('\n'),
      );
      expect(output).toContain('IMPORT_OK');
    },
    120_000,
  );

  it('refuses a python target with no toolchain directory provided, rather than failing deep inside the generators', async () => {
    const contract: Contract = {
      name: 'e2e-fixture-no-toolchain',
      spec: 'unused.yaml',
      python: { package: 'speckify-fixture-no-toolchain', client: true, server: false },
    };
    const plan = await computeContractPlan({
      contract: contract.name,
      bundledSpec: loadPlaceholderBundledSpec(),
      previous: null,
      classificationMap: {},
      coveredKeywords: new Set<string>(),
      toolchainImpactBump: 'none',
      oasdiffPath: '',
    });

    await expect(
      buildContract(plan, { contract, speckifyVersion: '0.0.0-test', outDir: '.speckify/out' }),
    ).rejects.toThrow(/no Python toolchain directory was provided/);
  });

  it('explains why the Python case is skipped when uv is not on PATH', () => {
    if (uvAvailable) return;
    expect(uvAvailable).toBe(false);
    console.log('Python end-to-end build skipped: uv not found on PATH.');
  });
});

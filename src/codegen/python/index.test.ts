import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { buildPythonPackage } from './index.js';
import { hasUv, loadFixtureAsBundledSpec, TOOLCHAIN_DIR } from './test-support.js';
import { resolveUv } from './uv.js';

const uvAvailable = await hasUv();
const describeTitle = uvAvailable
  ? 'buildPythonPackage (end-to-end integration, real uv + generators + build)'
  : 'buildPythonPackage (end-to-end integration, SKIPPED: uv not found on PATH)';

/** Runs `python -c <code>` inside an ephemeral uv environment with `wheelPath` installed. */
async function runPythonWithWheel(
  wheelPath: string,
  code: string,
  extraDeps: readonly string[] = [],
): Promise<string> {
  const uvPath = await resolveUv();
  const withArgs = [wheelPath, ...extraDeps].flatMap((dep) => ['--with', dep]);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(uvPath, [
      'run',
      '--no-project',
      '--python',
      '3.13',
      ...withArgs,
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

describe.skipIf(!uvAvailable)(describeTitle, () => {
  let projectDir: string;

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('generates models + client + server, builds a wheel and sdist, and the wheel installs and imports cleanly', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'speckify-build-'));
    const bundledSpec = loadFixtureAsBundledSpec('b-oneof-discriminator.bundled.yaml', '0.1.0');

    const result = await buildPythonPackage(
      {
        bundledSpec,
        packageName: 'speckify-fixture-b',
        version: '0.1.0',
        client: true,
        server: true,
        changelog: '## 0.1.0\n\n- Initial release.\n',
        speckifyVersion: '0.0.0-test',
      },
      { projectDir, toolchainDir: TOOLCHAIN_DIR },
    );

    expect(result.importName).toBe('speckify_fixture_b');
    expect(result.artifacts.some((a) => a.kind === 'wheel')).toBe(true);
    expect(result.artifacts.some((a) => a.kind === 'sdist')).toBe(true);

    const wheel = result.artifacts.find((a) => a.kind === 'wheel');
    if (!wheel) {
      throw new Error('no wheel produced');
    }

    const output = await runPythonWithWheel(
      wheel.path,
      [
        'import speckify_fixture_b',
        'import speckify_fixture_b.models as models',
        'import speckify_fixture_b.client as client',
        'import speckify_fixture_b.server as server',
        'import json',
        'spec = json.loads((__import__("importlib.resources", fromlist=["files"]).files(speckify_fixture_b) / "openapi.json").read_text())',
        'assert spec["info"]["version"] == "0.1.0", spec["info"]["version"]',
        'assert hasattr(models, "Cat")',
        'assert hasattr(server, "create_router")',
        'print("IMPORT_OK")',
      ].join('\n'),
      ['fastapi>=0.110'],
    );

    expect(output).toContain('IMPORT_OK');
  }, 120_000);

  // pyproject.toml's [tool.speckify] does not carry into the wheel's
  // METADATA, and hatchling's `packages = ["src/<name>"]` only ships files
  // that live under that directory -- a root-level CHANGELOG.md is not
  // included in the wheel by default, only in the sdist. Listing the real
  // built wheel's contents is the only thing that proves what a `pip
  // install` actually gets.
  it('includes openapi.json, CHANGELOG.md and the speckify version file in the built wheel', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'speckify-build-'));
    const bundledSpec = loadFixtureAsBundledSpec('b-oneof-discriminator.bundled.yaml', '0.2.0');

    const result = await buildPythonPackage(
      {
        bundledSpec,
        packageName: 'speckify-fixture-b3',
        version: '0.2.0',
        client: false,
        server: false,
        changelog: '## 0.2.0\n\n- Wheel packaging fix.\n',
        speckifyVersion: '0.4.1',
      },
      { projectDir, toolchainDir: TOOLCHAIN_DIR },
    );

    const wheel = result.artifacts.find((a) => a.kind === 'wheel');
    if (!wheel) {
      throw new Error('no wheel produced');
    }

    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('unzip', ['-l', wheel.path]);

    expect(stdout).toContain('speckify_fixture_b3/openapi.json');
    expect(stdout).toContain('speckify_fixture_b3/CHANGELOG.md');
    expect(stdout).toContain('speckify_fixture_b3/speckify.json');
  }, 120_000);

  it('stamps info.version and [tool.speckify] version into the generated package', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'speckify-build-'));
    const bundledSpec = loadFixtureAsBundledSpec('b-oneof-discriminator.bundled.yaml', '2.0.0');

    await buildPythonPackage(
      {
        bundledSpec,
        packageName: 'speckify-fixture-b2',
        version: '2.0.0',
        client: false,
        server: false,
        changelog: '## 2.0.0\n',
        speckifyVersion: '0.0.0-test',
      },
      { projectDir, toolchainDir: TOOLCHAIN_DIR },
    );

    const pyproject = await readFile(join(projectDir, 'pyproject.toml'), 'utf8');
    expect(pyproject).toContain('version = "2.0.0"');

    const openapiJson = await readFile(
      join(projectDir, 'src', 'speckify_fixture_b2', 'openapi.json'),
      'utf8',
    );
    const parsed = JSON.parse(openapiJson) as { info: { version: string } };
    expect(parsed.info.version).toBe('2.0.0');
  }, 60_000);
});

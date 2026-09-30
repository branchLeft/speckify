import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { buildPythonPackage } from './index.js';
import { hasUv, loadFixtureAsBundledSpec, TOOLCHAIN_DIR } from './test-support.js';
import { resolveUv } from './uv.js';

const uvAvailable = await hasUv();
const describeTitle = uvAvailable
  ? 'pyright --strict over a consumer of the generated package'
  : 'pyright --strict over a consumer of the generated package (SKIPPED: uv not found on PATH)';

function run(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], cwd ? { cwd } : {});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode !== 0 && exitCode !== 1) {
        // pyright itself exits 1 when it finds diagnostics - that's the case under test.
        reject(
          new Error(`${command} ${args.join(' ')} failed unexpectedly:\n${stdout}\n${stderr}`),
        );
        return;
      }
      resolvePromise({ stdout, exitCode });
    });
  });
}

const CONSUMER_SOURCE = `
from __future__ import annotations

import typing

from speckify_fixture_b import models
from speckify_fixture_b.client import Client
from speckify_fixture_b.client.api.default.create_pet import asyncio as create_pet_async
from speckify_fixture_b.client.models.cat import Cat
from speckify_fixture_b.client.models.cat_pet_type import CatPetType
from speckify_fixture_b.server import Handlers, create_router
from speckify_fixture_b.server.handlers import CreatePetResponse201


class ConsumerHandlers:
    async def create_pet(self, *, body: models.Pet) -> CreatePetResponse201:
        return CreatePetResponse201(body=body)


def build_router() -> None:
    handlers: Handlers = ConsumerHandlers()
    create_router(handlers)


async def call_client(client: Client) -> None:
    cat = Cat(pet_type=CatPetType.CAT, meow_volume=5)
    result = await create_pet_async(client=client, body=cat)
    if result is not None:
        typing.reveal_type(result)
`;

describe.skipIf(!uvAvailable)(describeTitle, () => {
  let projectDir: string;
  let workDir: string;

  afterEach(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it('reports zero errors for a consumer file that uses the client and implements Handlers', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'speckify-pyright-pkg-'));
    const bundledSpec = loadFixtureAsBundledSpec('b-oneof-discriminator.bundled.yaml', '0.1.0');

    const result = await buildPythonPackage(
      {
        bundledSpec,
        packageName: 'speckify-fixture-b',
        version: '0.1.0',
        client: true,
        server: true,
        changelog: '## 0.1.0\n',
        speckifyVersion: '0.0.0-test',
      },
      { projectDir, toolchainDir: TOOLCHAIN_DIR },
    );
    const wheel = result.artifacts.find((a) => a.kind === 'wheel');
    if (!wheel) throw new Error('no wheel produced');

    workDir = await mkdtemp(join(tmpdir(), 'speckify-pyright-work-'));
    const uvPath = await resolveUv();
    const venvDir = join(workDir, 'venv');
    await run(uvPath, ['venv', venvDir, '--python', '3.13']);
    const venvPython = join(venvDir, 'bin', 'python');
    await run(uvPath, ['pip', 'install', '--python', venvPython, wheel.path, 'fastapi>=0.110']);

    const consumerPath = join(workDir, 'consumer.py');
    await writeFile(consumerPath, CONSUMER_SOURCE, 'utf8');
    await writeFile(
      join(workDir, 'pyrightconfig.json'),
      JSON.stringify({ typeCheckingMode: 'strict' }),
      'utf8',
    );

    const { stdout, exitCode } = await run(
      uvPath,
      ['run', '--frozen', 'pyright', '--outputjson', '--pythonpath', venvPython, consumerPath],
      TOOLCHAIN_DIR,
    );

    const report = JSON.parse(stdout) as {
      summary: { errorCount: number };
      generalDiagnostics: unknown[];
    };
    expect(report.summary.errorCount, JSON.stringify(report.generalDiagnostics, null, 2)).toBe(0);
    expect(exitCode).toBe(0);
  }, 180_000);
});

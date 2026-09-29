import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateServer } from './server.js';
import { hasUv, loadFixtureAsBundledSpec, TOOLCHAIN_DIR } from './test-support.js';

const uvAvailable = await hasUv();
const describeTitle = uvAvailable
  ? 'generateServer (integration, real uv + the Jinja2 templates)'
  : 'generateServer (integration, SKIPPED: uv not found on PATH)';

describe.skipIf(!uvAvailable)(describeTitle, () => {
  let targetDir: string;

  afterEach(async () => {
    if (targetDir) {
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it('writes __init__.py, handlers.py and router.py under server/', async () => {
    targetDir = await mkdtemp(join(tmpdir(), 'speckify-server-'));
    const bundledSpec = loadFixtureAsBundledSpec('b-oneof-discriminator.bundled.yaml');

    await generateServer(bundledSpec, { toolchainDir: TOOLCHAIN_DIR, targetDir });

    const entries = await readdir(join(targetDir, 'server'));
    expect(entries.sort()).toEqual(['__init__.py', 'handlers.py', 'router.py']);
  }, 30_000);

  it('emits one Handlers protocol method per operationId, including the octet-stream operation', async () => {
    targetDir = await mkdtemp(join(tmpdir(), 'speckify-server-'));
    const bundledSpec = loadFixtureAsBundledSpec('combined.bundled.yaml');

    await generateServer(bundledSpec, { toolchainDir: TOOLCHAIN_DIR, targetDir });

    const handlers = await readFile(join(targetDir, 'server', 'handlers.py'), 'utf8');
    expect(handlers).toContain('async def create_pet(');
    expect(handlers).toContain('async def upload_blob(');
    expect(handlers).toContain('body: typing.AsyncIterator[bytes]');
    expect(handlers).toContain('class Handlers(typing.Protocol):');
  }, 30_000);
});

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

  it('emits no parameters at all for an operation with no params and no body, not a bare `*,`', async () => {
    // getVersion (combined.bundled.yaml) takes neither parameters nor a
    // request body: handlers.py.jinja used to unconditionally emit a bare
    // `*,` before the parameter list, which for this shape left nothing
    // after it (`async def get_version(self, *,)`) — a SyntaxError that
    // made the whole generated package fail to import. The full
    // import-and-route proof is `test_render_server.py`'s
    // `no_params_no_body` case, run by the Python suite this covers.
    targetDir = await mkdtemp(join(tmpdir(), 'speckify-server-'));
    const bundledSpec = loadFixtureAsBundledSpec('combined.bundled.yaml');

    await generateServer(bundledSpec, { toolchainDir: TOOLCHAIN_DIR, targetDir });

    const handlers = await readFile(join(targetDir, 'server', 'handlers.py'), 'utf8');
    const start = handlers.indexOf('async def get_version(');
    expect(start).toBeGreaterThan(-1);
    const signature = handlers.slice(start, handlers.indexOf('->', start));
    expect(signature).not.toContain('*');
    expect(signature).toContain('self,');
  }, 30_000);
});

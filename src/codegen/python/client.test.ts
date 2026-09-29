import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateClient } from './client.js';
import { CompletenessGuardError } from './errors.js';
import { hasUv, loadFixtureAsBundledSpec, TOOLCHAIN_DIR } from './test-support.js';

const uvAvailable = await hasUv();
const describeTitle = uvAvailable
  ? 'generateClient (integration, real uv + openapi-python-client)'
  : 'generateClient (integration, SKIPPED: uv not found on PATH)';

describe.skipIf(!uvAvailable)(describeTitle, () => {
  let targetDir: string;

  afterEach(async () => {
    if (targetDir) {
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it('generates a complete client for a spec with no generator-limitation shapes', async () => {
    targetDir = await mkdtemp(join(tmpdir(), 'speckify-client-'));
    const bundledSpec = loadFixtureAsBundledSpec('b-oneof-discriminator.bundled.yaml');

    await generateClient(bundledSpec, { toolchainDir: TOOLCHAIN_DIR, targetDir });

    const entries = await readdir(join(targetDir, 'client'));
    expect(entries).toContain('api');
    expect(entries).toContain('models');
    const created = await readFile(
      join(targetDir, 'client', 'api', 'default', 'create_pet.py'),
      'utf8',
    );
    expect(created).toContain('def sync');
  }, 60_000);

  it('refuses the combined fixture: openapi-python-client silently drops uploadBlob', async () => {
    // uploadBlob has a `format: date-time` header param — the known
    // openapi-python-client 0.29.1 limitation the completeness guard exists for.
    targetDir = await mkdtemp(join(tmpdir(), 'speckify-client-'));
    const bundledSpec = loadFixtureAsBundledSpec('combined.bundled.yaml');

    const error = await generateClient(bundledSpec, {
      toolchainDir: TOOLCHAIN_DIR,
      targetDir,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CompletenessGuardError);
    expect((error as CompletenessGuardError).missingOperationIds).toEqual(['uploadBlob']);
  }, 60_000);
});

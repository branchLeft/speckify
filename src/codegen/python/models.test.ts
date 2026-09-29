import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateModels } from './models.js';
import { hasUv, loadFixtureAsBundledSpec, TOOLCHAIN_DIR } from './test-support.js';

// Real datamodel-code-generator run via the pinned toolchain. Skipped, with a
// clear reason in the describe title, on a machine with no `uv` on PATH
// rather than failing CI for an unrelated environment gap.
const uvAvailable = await hasUv();
const describeTitle = uvAvailable
  ? 'generateModels (integration, real uv + datamodel-code-generator)'
  : 'generateModels (integration, SKIPPED: uv not found on PATH)';

describe.skipIf(!uvAvailable)(describeTitle, () => {
  let targetDir: string;

  afterEach(async () => {
    if (targetDir) {
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it('generates a single models.py when nothing forces directory mode', async () => {
    targetDir = await mkdtemp(join(tmpdir(), 'speckify-models-'));
    // No external $ref here, so nothing forces directory mode — the common case.
    const bundledSpec = loadFixtureAsBundledSpec('b-oneof-discriminator.bundled.yaml');

    await generateModels(bundledSpec, { toolchainDir: TOOLCHAIN_DIR, targetDir });

    const entries = await readdir(targetDir);
    expect(entries).toContain('models.py');
    const contents = await readFile(join(targetDir, 'models.py'), 'utf8');
    expect(contents).toContain('class Cat(');
    expect(contents).toContain('class Dog(');
  }, 60_000);

  it('falls back to a models/ package for the combined fixture as bundled today (it still carries $id)', async () => {
    targetDir = await mkdtemp(join(tmpdir(), 'speckify-models-'));
    const bundledSpec = loadFixtureAsBundledSpec('combined.bundled.yaml');

    await generateModels(bundledSpec, { toolchainDir: TOOLCHAIN_DIR, targetDir });

    const entries = await readdir(targetDir);
    expect(entries).toContain('models');
  }, 60_000);

  it('falls back to a models/ package when the bundle keeps $id on an inlined external schema', async () => {
    targetDir = await mkdtemp(join(tmpdir(), 'speckify-models-'));
    // This fixture is bundled by Redocly with $id/$schema still on the inlined
    // external schema (the spike's finding) — the core bundler stripping them
    // is a separate change, so this module must tolerate either shape.
    const bundledSpec = loadFixtureAsBundledSpec('a-external-ref.bundled.yaml');

    await generateModels(bundledSpec, { toolchainDir: TOOLCHAIN_DIR, targetDir });

    const entries = await readdir(targetDir);
    expect(entries).toContain('models');
  }, 60_000);
});

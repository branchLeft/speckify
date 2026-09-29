import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InitError } from './errors.js';
import { runInit } from './run-init.js';

describe('runInit', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'speckify-init-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('writes speckify.yaml and the caller workflow for a detected spec', async () => {
    await writeFile(join(cwd, 'openapi.yaml'), 'openapi: 3.1.0');
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ object: { sha: 'a'.repeat(40), type: 'commit' } })),
      );

    const result = await runInit({
      cwd,
      owner: 'acme',
      speckifyVersion: '1.0.0',
      speckifyRepo: 'speckify/speckify',
      fetchImpl,
    });

    expect(result.contracts).toEqual(['openapi.yaml']);
    expect(result.warning).toBeUndefined();

    const config = await readFile(join(cwd, 'speckify.yaml'), 'utf8');
    expect(config).toContain('@acme/api');

    const workflow = await readFile(join(cwd, '.github', 'workflows', 'speckify.yml'), 'utf8');
    expect(workflow).toContain(`@${'a'.repeat(40)}`);
  });

  it('throws InitError when no spec is found', async () => {
    await expect(
      runInit({ cwd, owner: 'acme', speckifyVersion: '1.0.0', speckifyRepo: 'speckify/speckify' }),
    ).rejects.toThrow(InitError);
  });

  it('refuses to overwrite an existing speckify.yaml without --force', async () => {
    await writeFile(join(cwd, 'openapi.yaml'), 'openapi: 3.1.0');
    await writeFile(join(cwd, 'speckify.yaml'), 'existing: true');
    await expect(
      runInit({ cwd, owner: 'acme', speckifyVersion: '1.0.0', speckifyRepo: 'speckify/speckify' }),
    ).rejects.toThrow(InitError);
  });

  it('refuses to overwrite an existing workflow file without --force', async () => {
    await writeFile(join(cwd, 'openapi.yaml'), 'openapi: 3.1.0');
    await mkdir(join(cwd, '.github', 'workflows'), { recursive: true });
    await writeFile(join(cwd, '.github', 'workflows', 'speckify.yml'), 'existing: true');
    await expect(
      runInit({ cwd, owner: 'acme', speckifyVersion: '1.0.0', speckifyRepo: 'speckify/speckify' }),
    ).rejects.toThrow(InitError);
  });

  it('overwrites both files when force is set', async () => {
    await writeFile(join(cwd, 'openapi.yaml'), 'openapi: 3.1.0');
    await writeFile(join(cwd, 'speckify.yaml'), 'existing: true');
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ object: { sha: 'a'.repeat(40), type: 'commit' } })),
      );

    await runInit({
      cwd,
      owner: 'acme',
      speckifyVersion: '1.0.0',
      speckifyRepo: 'speckify/speckify',
      force: true,
      fetchImpl,
    });

    const config = await readFile(join(cwd, 'speckify.yaml'), 'utf8');
    expect(config).not.toContain('existing: true');
  });

  it('carries the resolver warning through when SHA resolution fails', async () => {
    await writeFile(join(cwd, 'openapi.yaml'), 'openapi: 3.1.0');
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));

    const result = await runInit({
      cwd,
      owner: 'acme',
      speckifyVersion: '1.0.0',
      speckifyRepo: 'speckify/speckify',
      fetchImpl,
    });

    expect(result.warning).toContain('offline');
    const workflow = await readFile(result.workflowPath, 'utf8');
    expect(workflow).toContain('@v1.0.0');
  });

  it('honours a custom configPath', async () => {
    await writeFile(join(cwd, 'openapi.yaml'), 'openapi: 3.1.0');
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ object: { sha: 'a'.repeat(40), type: 'commit' } })),
      );

    const result = await runInit({
      cwd,
      owner: 'acme',
      speckifyVersion: '1.0.0',
      speckifyRepo: 'speckify/speckify',
      configPath: 'contracts/speckify.yaml',
      fetchImpl,
    });

    expect(result.configPath).toBe(join(cwd, 'contracts/speckify.yaml'));
    const content = await readFile(result.configPath, 'utf8');
    expect(content).toContain('publish');
  });
});

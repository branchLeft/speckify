import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PublishError } from './errors.js';
import { publishPypi } from './pypi.js';

describe('publishPypi', () => {
  let distDir: string;

  beforeEach(async () => {
    distDir = await mkdtemp(join(tmpdir(), 'speckify-pypi-'));
  });

  afterEach(async () => {
    await rm(distDir, { recursive: true, force: true });
  });

  it('publishes every wheel and sdist in the dist directory via uv, trusted-publishing always', async () => {
    await writeFile(join(distDir, 'orders_api-1.0.0-py3-none-any.whl'), 'wheel');
    await writeFile(join(distDir, 'orders_api-1.0.0.tar.gz'), 'sdist');
    await writeFile(join(distDir, 'README.md'), 'not a dist file');

    const runProcess = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    await publishPypi({ distDir, packageName: 'orders-api', runProcess });

    expect(runProcess).toHaveBeenCalledTimes(1);
    const [command, args] = runProcess.mock.calls[0] as [string, string[]];
    expect(command).toBe('uv');
    expect(args).toEqual(
      expect.arrayContaining(['publish', '--trusted-publishing', 'always']) as unknown,
    );
    expect(args.some((arg) => arg.endsWith('.whl'))).toBe(true);
    expect(args.some((arg) => arg.endsWith('.tar.gz'))).toBe(true);
    expect(args.some((arg) => arg.endsWith('README.md'))).toBe(false);
  });

  it('throws PublishError when the dist directory has no distribution files', async () => {
    const runProcess = vi.fn();
    await expect(publishPypi({ distDir, packageName: 'orders-api', runProcess })).rejects.toThrow(
      PublishError,
    );
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('throws PublishError when the dist directory does not exist', async () => {
    await expect(
      publishPypi({ distDir: join(distDir, 'missing'), packageName: 'orders-api' }),
    ).rejects.toThrow(PublishError);
  });

  it('wraps a failing uv publish in a PublishError', async () => {
    await writeFile(join(distDir, 'orders_api-1.0.0.tar.gz'), 'sdist');
    const runProcess = vi.fn().mockRejectedValue(new Error('403'));
    await expect(publishPypi({ distDir, packageName: 'orders-api', runProcess })).rejects.toThrow(
      /403/,
    );
  });
});

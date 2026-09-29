import { describe, expect, it, vi } from 'vitest';

import { PublishError } from './errors.js';
import { publishNpm } from './npm.js';

describe('publishNpm', () => {
  it('runs npm publish against the given registry with a NODE_AUTH_TOKEN env var', async () => {
    const runProcess = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    await publishNpm({
      packageDir: '/pkg',
      packageName: '@acme/orders-api',
      registryUrl: 'https://npm.pkg.github.com',
      token: 'secret-token',
      owner: 'acme',
      runProcess,
    });

    expect(runProcess).toHaveBeenCalledWith(
      'npm',
      ['publish', '--registry', 'https://npm.pkg.github.com'],
      expect.objectContaining({
        cwd: '/pkg',
        env: expect.objectContaining({ NODE_AUTH_TOKEN: 'secret-token' }) as unknown,
      }),
    );
  });

  it('rejects a package whose scope does not match the configured owner, without running npm', async () => {
    const runProcess = vi.fn();
    await expect(
      publishNpm({
        packageDir: '/pkg',
        packageName: '@other/orders-api',
        registryUrl: 'https://npm.pkg.github.com',
        token: 'secret-token',
        owner: 'acme',
        runProcess,
      }),
    ).rejects.toThrow(PublishError);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('matches the owner case-insensitively', async () => {
    const runProcess = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    await expect(
      publishNpm({
        packageDir: '/pkg',
        packageName: '@acme/orders-api',
        registryUrl: 'https://npm.pkg.github.com',
        token: 'secret-token',
        owner: 'ACME',
        runProcess,
      }),
    ).resolves.toBeUndefined();
  });

  it('wraps a failing subprocess in a PublishError', async () => {
    const runProcess = vi.fn().mockRejectedValue(new Error('E403 Forbidden'));
    await expect(
      publishNpm({
        packageDir: '/pkg',
        packageName: '@acme/orders-api',
        registryUrl: 'https://npm.pkg.github.com',
        token: 'secret-token',
        owner: 'acme',
        runProcess,
      }),
    ).rejects.toThrow(/E403 Forbidden/);
  });
});

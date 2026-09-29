import { describe, expect, it, vi } from 'vitest';

import type { RegistryRecord } from '../record/index.js';
import { hasFailures, publishContract } from './contract.js';
import type { NpmPublishTarget, PyPiPublishTarget } from './types.js';

function fakeRegistry(version: string | null): RegistryRecord {
  return {
    latest: vi.fn().mockResolvedValue(version === null ? null : { version, bundledSpec: '{}' }),
  };
}

const npmTarget: NpmPublishTarget = {
  kind: 'npm',
  label: 'orders-api-ts',
  packageDir: '/pkg/ts',
  packageName: '@acme/orders-api',
  version: '1.1.0',
};

const pypiTarget: PyPiPublishTarget = {
  kind: 'pypi',
  label: 'orders-api-py',
  distDir: '/pkg/py/dist',
  packageName: 'orders-api',
  version: '1.1.0',
};

describe('publishContract', () => {
  it('publishes every target that is not already at the target version', async () => {
    const publishNpmFn = vi.fn().mockResolvedValue(undefined);
    const publishPypiFn = vi.fn().mockResolvedValue(undefined);

    const outcomes = await publishContract({
      targets: [npmTarget, pypiTarget],
      registries: { npm: fakeRegistry('1.0.0'), pypi: fakeRegistry(null) },
      publishNpmFn,
      publishPypiFn,
      npmRegistryUrl: 'https://npm.pkg.github.com',
      npmToken: 'token',
      npmOwner: 'acme',
    });

    expect(publishNpmFn).toHaveBeenCalledTimes(1);
    expect(publishPypiFn).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([
      { target: npmTarget, status: 'published' },
      { target: pypiTarget, status: 'published' },
    ]);
    expect(hasFailures(outcomes)).toBe(false);
  });

  it('skips a target whose version the registry already has', async () => {
    const publishNpmFn = vi.fn().mockResolvedValue(undefined);

    const outcomes = await publishContract({
      targets: [npmTarget],
      registries: { npm: fakeRegistry('1.1.0') },
      publishNpmFn,
      npmRegistryUrl: 'https://npm.pkg.github.com',
      npmToken: 'token',
      npmOwner: 'acme',
    });

    expect(publishNpmFn).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ target: npmTarget, status: 'already-published' }]);
  });

  it("one target's failure does not stop the others, and is reported with its reason", async () => {
    const publishNpmFn = vi.fn().mockRejectedValue(new Error('403 Forbidden'));
    const publishPypiFn = vi.fn().mockResolvedValue(undefined);

    const outcomes = await publishContract({
      targets: [npmTarget, pypiTarget],
      registries: {},
      publishNpmFn,
      publishPypiFn,
      npmRegistryUrl: 'https://npm.pkg.github.com',
      npmToken: 'token',
      npmOwner: 'acme',
    });

    expect(publishPypiFn).toHaveBeenCalledTimes(1);
    expect(outcomes[0]).toEqual({
      target: npmTarget,
      status: 'failed',
      error: expect.stringContaining('403 Forbidden') as unknown,
    });
    expect(outcomes[1]).toEqual({ target: pypiTarget, status: 'published' });
    expect(hasFailures(outcomes)).toBe(true);
  });

  it('treats a target with no registry configured as never published', async () => {
    const publishNpmFn = vi.fn().mockResolvedValue(undefined);
    const outcomes = await publishContract({
      targets: [npmTarget],
      registries: {},
      publishNpmFn,
      npmRegistryUrl: 'https://npm.pkg.github.com',
      npmToken: 'token',
      npmOwner: 'acme',
    });
    expect(publishNpmFn).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([{ target: npmTarget, status: 'published' }]);
  });
});

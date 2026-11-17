import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RegistryRecord } from '../record/index.js';
import { PublishError } from './errors.js';
import type { PackManifest } from './pack-manifest.js';
import { packContract, publishFromPack } from './pack-publish.js';
import type { NpmPublishTarget, PyPiPublishTarget } from './types.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'speckify-pack-publish-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');

function fakeRegistry(version: string | null, bundledSpec = '{}'): RegistryRecord {
  return {
    latest: vi.fn().mockResolvedValue(version === null ? null : { version, bundledSpec }),
  };
}

const npmTarget: NpmPublishTarget = {
  kind: 'npm',
  label: 'orders-api-typescript',
  packageDir: '/out/orders-api/typescript',
  packageName: '@acme/orders-api',
  version: '1.1.0',
};

const pypiTarget: PyPiPublishTarget = {
  kind: 'pypi',
  label: 'orders-api-python',
  distDir: '/out/orders-api/python/dist',
  packageName: 'orders-api',
  version: '1.1.0',
};

const input = {
  contract: 'orders-api',
  version: '1.1.0',
  changelog: '# Changelog\n',
  bundledSpec: '{"info":{"version":"1.1.0"}}',
  npmOwner: 'acme',
};

describe('packContract', () => {
  it('packs an unpublished npm package and records its tarball and digest, and records the Python dist', async () => {
    const packNpmFn = vi.fn().mockResolvedValue({
      fileName: 'acme-orders-api-1.1.0.tgz',
      path: '/packs/acme-orders-api-1.1.0.tgz',
      sha256: 'f'.repeat(64),
    });

    const { contract, outcomes } = await packContract({
      ...input,
      targets: [npmTarget, pypiTarget],
      packDir: '/packs',
      registries: { npm: fakeRegistry('1.0.0'), pypi: fakeRegistry(null) },
      packNpmFn,
    });

    expect(packNpmFn).toHaveBeenCalledWith({
      packageDir: '/out/orders-api/typescript',
      packDir: '/packs',
    });
    expect(contract).toEqual({
      name: 'orders-api',
      version: '1.1.0',
      changelog: '# Changelog\n',
      bundledSpec: '{"info":{"version":"1.1.0"}}',
      targets: [
        {
          kind: 'npm',
          label: 'orders-api-typescript',
          packageName: '@acme/orders-api',
          version: '1.1.0',
          tarball: 'acme-orders-api-1.1.0.tgz',
          sha256: 'f'.repeat(64),
        },
        {
          kind: 'pypi',
          label: 'orders-api-python',
          packageName: 'orders-api',
          version: '1.1.0',
          distDir: '/out/orders-api/python/dist',
        },
      ],
    });
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['published', 'published']);
  });

  it('packs nothing for a version the registry already holds with the same spec', async () => {
    const packNpmFn = vi.fn();
    const { contract, outcomes } = await packContract({
      ...input,
      targets: [npmTarget],
      packDir: '/packs',
      registries: { npm: fakeRegistry('1.1.0', input.bundledSpec) },
      packNpmFn,
    });

    expect(packNpmFn).not.toHaveBeenCalled();
    expect(contract.targets).toEqual([]);
    expect(outcomes).toEqual([{ target: npmTarget, status: 'already-published' }]);
  });

  it('reports a package outside the owner scope as failed, and packs nothing for it', async () => {
    const packNpmFn = vi.fn();
    const { contract, outcomes } = await packContract({
      ...input,
      npmOwner: 'someone-else',
      targets: [npmTarget],
      packDir: '/packs',
      registries: { npm: fakeRegistry(null) },
      packNpmFn,
    });

    expect(packNpmFn).not.toHaveBeenCalled();
    expect(contract.targets).toEqual([]);
    expect(outcomes[0]?.status).toBe('failed');
    expect(outcomes[0]?.error).toMatch(/scope/);
  });

  it('reports a failing npm pack as failed without stopping the other targets', async () => {
    const packNpmFn = vi.fn().mockRejectedValue(new PublishError('npm pack failed'));
    const { contract, outcomes } = await packContract({
      ...input,
      targets: [npmTarget, pypiTarget],
      packDir: '/packs',
      registries: { npm: fakeRegistry(null), pypi: fakeRegistry(null) },
      packNpmFn,
    });

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'published']);
    expect(contract.targets.map((target) => target.kind)).toEqual(['pypi']);
  });

  it('fails a version published with a different spec rather than packing it', async () => {
    const packNpmFn = vi.fn();
    const { outcomes } = await packContract({
      ...input,
      targets: [npmTarget],
      packDir: '/packs',
      registries: { npm: fakeRegistry('1.1.0', '{"other":true}') },
      packNpmFn,
    });

    expect(packNpmFn).not.toHaveBeenCalled();
    expect(outcomes[0]?.status).toBe('failed');
  });
});

describe('publishFromPack', () => {
  async function packedManifest(
    tarballBytes = 'attested bytes',
  ): Promise<{ packDir: string; manifest: PackManifest; digest: string }> {
    const packDir = await tempDir();
    await writeFile(path.join(packDir, 'acme-orders-api-1.1.0.tgz'), tarballBytes);
    const digest = sha256('attested bytes');
    const manifest: PackManifest = {
      schemaVersion: 1,
      contracts: [
        {
          name: 'orders-api',
          version: '1.1.0',
          changelog: '# Changelog\n',
          bundledSpec: '{"info":{"version":"1.1.0"}}',
          targets: [
            {
              kind: 'npm',
              label: 'orders-api-typescript',
              packageName: '@acme/orders-api',
              version: '1.1.0',
              tarball: 'acme-orders-api-1.1.0.tgz',
              sha256: digest,
            },
            {
              kind: 'pypi',
              label: 'orders-api-python',
              packageName: 'orders-api',
              version: '1.1.0',
              distDir: '/out/orders-api/python/dist',
            },
          ],
        },
      ],
    };
    return { packDir, manifest, digest };
  }

  function bundleFor(digest: string): string {
    const statement = { subject: [{ name: 'x.tgz', digest: { sha256: digest } }] };
    return JSON.stringify({
      dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') },
    });
  }

  const common = {
    registries: { npm: fakeRegistry(null), pypi: fakeRegistry(null) },
    npmRegistryUrl: 'https://npm.pkg.github.com',
    npmToken: 'token',
    npmOwner: 'acme',
  };

  it('publishes the packed tarball itself, then the Python dist, when the digests match the attestation', async () => {
    const { packDir, manifest, digest } = await packedManifest();
    const publishNpmFn = vi.fn().mockResolvedValue(undefined);
    const publishPypiFn = vi.fn().mockResolvedValue(undefined);

    const results = await publishFromPack({
      ...common,
      packDir,
      manifest,
      attestationBundles: [bundleFor(digest)],
      publishNpmFn,
      publishPypiFn,
    });

    expect(publishNpmFn).toHaveBeenCalledWith(
      expect.objectContaining({
        tarball: path.join(packDir, 'acme-orders-api-1.1.0.tgz'),
        packageName: '@acme/orders-api',
        owner: 'acme',
      }),
    );
    expect(publishPypiFn).toHaveBeenCalledWith({
      distDir: '/out/orders-api/python/dist',
      packageName: 'orders-api',
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: 'orders-api',
      version: '1.1.0',
      changelog: '# Changelog\n',
      bundledSpec: '{"info":{"version":"1.1.0"}}',
    });
    expect(results[0]?.outcomes.map((outcome) => outcome.status)).toEqual([
      'published',
      'published',
    ]);
  });

  it('publishes nothing when the tarball on disk is not the one that was packed', async () => {
    const { packDir, manifest, digest } = await packedManifest('swapped bytes');
    const publishNpmFn = vi.fn();
    const publishPypiFn = vi.fn();

    await expect(
      publishFromPack({
        ...common,
        packDir,
        manifest,
        attestationBundles: [bundleFor(digest)],
        publishNpmFn,
        publishPypiFn,
      }),
    ).rejects.toThrow(/orders-api-typescript.*changed since it was packed/);
    expect(publishNpmFn).not.toHaveBeenCalled();
    expect(publishPypiFn).not.toHaveBeenCalled();
  });

  it('publishes nothing when the tarball is missing', async () => {
    const { packDir, manifest } = await packedManifest();
    const target = manifest.contracts[0]?.targets[0];
    if (target?.kind === 'npm') target.tarball = 'gone-1.1.0.tgz';
    const publishNpmFn = vi.fn();

    await expect(publishFromPack({ ...common, packDir, manifest, publishNpmFn })).rejects.toThrow(
      PublishError,
    );
    expect(publishNpmFn).not.toHaveBeenCalled();
  });

  it('publishes nothing when the attestation does not cover the tarball digest', async () => {
    const { packDir, manifest } = await packedManifest();
    const publishNpmFn = vi.fn();
    const publishPypiFn = vi.fn();

    await expect(
      publishFromPack({
        ...common,
        packDir,
        manifest,
        attestationBundles: [bundleFor('0'.repeat(64))],
        publishNpmFn,
        publishPypiFn,
      }),
    ).rejects.toThrow(/not in the attestation/);
    expect(publishNpmFn).not.toHaveBeenCalled();
    expect(publishPypiFn).not.toHaveBeenCalled();
  });

  it('publishes nothing when an attestation was asked for but is unreadable', async () => {
    const { packDir, manifest } = await packedManifest();
    const publishNpmFn = vi.fn();

    await expect(
      publishFromPack({
        ...common,
        packDir,
        manifest,
        attestationBundles: ['not a bundle'],
        publishNpmFn,
      }),
    ).rejects.toThrow(PublishError);
    expect(publishNpmFn).not.toHaveBeenCalled();
  });

  it('publishes nothing when an attestation is required and none was given', async () => {
    const { packDir, manifest } = await packedManifest();
    const publishNpmFn = vi.fn();
    const publishPypiFn = vi.fn();

    for (const attestationBundles of [undefined, []]) {
      await expect(
        publishFromPack({
          ...common,
          packDir,
          manifest,
          requireAttestation: true,
          attestationBundles,
          publishNpmFn,
          publishPypiFn,
        }),
      ).rejects.toThrow(/no attestation was given/);
    }
    expect(publishNpmFn).not.toHaveBeenCalled();
    expect(publishPypiFn).not.toHaveBeenCalled();
  });

  it('does not require an attestation when there is no tarball to publish', async () => {
    const { packDir, manifest } = await packedManifest();
    const contract = manifest.contracts[0];
    if (contract) contract.targets = contract.targets.filter((target) => target.kind === 'pypi');
    const publishPypiFn = vi.fn().mockResolvedValue(undefined);

    await publishFromPack({
      ...common,
      packDir,
      manifest,
      requireAttestation: true,
      publishPypiFn,
    });

    expect(publishPypiFn).toHaveBeenCalledTimes(1);
  });

  it('verifies every tarball with the given verifier before it publishes anything', async () => {
    const { packDir, manifest, digest } = await packedManifest();
    const verifyTarball = vi.fn().mockResolvedValue(undefined);
    const publishNpmFn = vi.fn().mockResolvedValue(undefined);
    const publishPypiFn = vi.fn().mockResolvedValue(undefined);

    await publishFromPack({
      ...common,
      packDir,
      manifest,
      attestationBundles: [bundleFor(digest)],
      verifyTarball,
      publishNpmFn,
      publishPypiFn,
    });

    expect(verifyTarball).toHaveBeenCalledWith({
      label: 'orders-api-typescript',
      tarballPath: path.join(packDir, 'acme-orders-api-1.1.0.tgz'),
      sha256: digest,
    });
    expect(verifyTarball.mock.invocationCallOrder[0]).toBeLessThan(
      publishNpmFn.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('publishes nothing when the verifier refuses a tarball', async () => {
    const { packDir, manifest, digest } = await packedManifest();
    const verifyTarball = vi.fn().mockRejectedValue(new PublishError('wrong signer'));
    const publishNpmFn = vi.fn();
    const publishPypiFn = vi.fn();

    await expect(
      publishFromPack({
        ...common,
        packDir,
        manifest,
        attestationBundles: [bundleFor(digest)],
        verifyTarball,
        publishNpmFn,
        publishPypiFn,
      }),
    ).rejects.toThrow(/wrong signer/);
    expect(publishNpmFn).not.toHaveBeenCalled();
    expect(publishPypiFn).not.toHaveBeenCalled();
  });

  it('publishes without an attestation check when none was asked for', async () => {
    const { packDir, manifest } = await packedManifest();
    const publishNpmFn = vi.fn().mockResolvedValue(undefined);
    const publishPypiFn = vi.fn().mockResolvedValue(undefined);

    await publishFromPack({ ...common, packDir, manifest, publishNpmFn, publishPypiFn });

    expect(publishNpmFn).toHaveBeenCalledTimes(1);
  });

  it('skips a version the registry already holds, and reports a failed target without stopping the rest', async () => {
    const { packDir, manifest, digest } = await packedManifest();
    const publishNpmFn = vi.fn();
    const publishPypiFn = vi.fn().mockRejectedValue(new PublishError('uv publish failed'));

    const results = await publishFromPack({
      ...common,
      registries: {
        npm: fakeRegistry('1.1.0', '{"info":{"version":"1.1.0"}}'),
        pypi: fakeRegistry(null),
      },
      packDir,
      manifest,
      attestationBundles: [bundleFor(digest)],
      publishNpmFn,
      publishPypiFn,
    });

    expect(publishNpmFn).not.toHaveBeenCalled();
    expect(results[0]?.outcomes.map((outcome) => outcome.status)).toEqual([
      'already-published',
      'failed',
    ]);
  });
});

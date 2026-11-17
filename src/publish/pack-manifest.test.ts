import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PublishError } from './errors.js';
import {
  PACK_MANIFEST_FILENAME,
  readPackManifest,
  writePackManifest,
  type PackManifest,
} from './pack-manifest.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'speckify-manifest-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const manifest: PackManifest = {
  schemaVersion: 1,
  contracts: [
    {
      name: 'orders-api',
      version: '1.1.0',
      changelog: '# Changelog\n',
      bundledSpec: '{"openapi":"3.1.0"}',
      targets: [
        {
          kind: 'npm',
          label: 'orders-api-typescript',
          packageName: '@acme/orders-api',
          version: '1.1.0',
          tarball: 'acme-orders-api-1.1.0.tgz',
          sha256: 'a'.repeat(64),
        },
        {
          kind: 'pypi',
          label: 'orders-api-python',
          packageName: 'orders-api',
          version: '1.1.0',
          distDir: '/work/.speckify/out/orders-api/python/dist',
        },
      ],
    },
  ],
};

describe('writePackManifest / readPackManifest', () => {
  it('round-trips a manifest through the pack directory, creating the directory', async () => {
    const packDir = path.join(await tempDir(), 'nested', 'pack');
    const written = await writePackManifest(packDir, manifest);

    expect(written).toBe(path.join(packDir, PACK_MANIFEST_FILENAME));
    await expect(readPackManifest(packDir)).resolves.toEqual(manifest);
  });

  it('refuses a pack directory with no manifest', async () => {
    const packDir = await tempDir();
    await expect(readPackManifest(packDir)).rejects.toThrow(PublishError);
  });

  it('refuses a manifest that is not JSON', async () => {
    const packDir = await tempDir();
    await writeFile(path.join(packDir, PACK_MANIFEST_FILENAME), 'not json');
    await expect(readPackManifest(packDir)).rejects.toThrow(/not valid JSON/);
  });

  async function readerRejects(change: (copy: PackManifest) => unknown): Promise<void> {
    const packDir = await tempDir();
    const copy = JSON.parse(JSON.stringify(manifest)) as PackManifest;
    await writeFile(path.join(packDir, PACK_MANIFEST_FILENAME), JSON.stringify(change(copy)));
    await expect(readPackManifest(packDir)).rejects.toThrow(PublishError);
  }

  it('refuses an unknown schema version', async () => {
    await readerRejects((copy) => ({ ...copy, schemaVersion: 2 }));
  });

  it.each(['../escape.tgz', 'sub/a.tgz', 'a.zip', '/abs/a.tgz', 'a\\b.tgz'])(
    'refuses the tarball name %j: it must be a plain file name inside the pack directory',
    async (tarball) => {
      await readerRejects((copy) => {
        const target = copy.contracts[0]?.targets[0];
        if (target?.kind === 'npm') target.tarball = tarball;
        return copy;
      });
    },
  );

  it.each(['abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)])(
    'refuses the digest %j: it must be 64 lowercase hex characters',
    async (sha256) => {
      await readerRejects((copy) => {
        const target = copy.contracts[0]?.targets[0];
        if (target?.kind === 'npm') target.sha256 = sha256;
        return copy;
      });
    },
  );

  it('refuses a target of a kind it does not know', async () => {
    await readerRejects((copy) => {
      const contract = copy.contracts[0];
      if (contract) contract.targets = [{ kind: 'rubygems' } as never];
      return copy;
    });
  });

  it('is written as readable JSON ending in a newline', async () => {
    const packDir = await tempDir();
    const written = await writePackManifest(packDir, manifest);
    const text = await readFile(written, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "contracts"');
  });
});

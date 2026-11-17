import { createHash } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PublishError } from './errors.js';
import { packNpm, sha256OfFile } from './pack.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'speckify-pack-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');

describe('sha256OfFile', () => {
  it('is the lowercase hex sha-256 of the file bytes', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.tgz');
    await writeFile(file, 'tarball bytes');
    await expect(sha256OfFile(file)).resolves.toBe(sha256('tarball bytes'));
  });
});

describe('packNpm', () => {
  it('runs npm pack into the pack directory and reports the tarball with its digest', async () => {
    const packDir = await tempDir();
    await writeFile(path.join(packDir, 'acme-orders-1.0.0.tgz'), 'packed');
    const runProcess = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([{ filename: 'acme-orders-1.0.0.tgz' }]),
      stderr: '',
    });

    const packed = await packNpm({ packageDir: '/pkg', packDir, runProcess });

    expect(runProcess).toHaveBeenCalledWith(
      'npm',
      ['pack', '--pack-destination', packDir, '--json'],
      expect.objectContaining({ cwd: '/pkg' }),
    );
    expect(packed).toEqual({
      fileName: 'acme-orders-1.0.0.tgz',
      path: path.join(packDir, 'acme-orders-1.0.0.tgz'),
      sha256: sha256('packed'),
    });
  });

  // `npm pack --pack-destination` does not create the directory: it fails
  // with ENOENT on the tarball's path, found only by running the built CLI.
  it('creates the pack directory before npm pack runs, since npm will not', async () => {
    const packDir = path.join(await tempDir(), 'nested', 'pack');
    const runProcess = vi.fn().mockImplementation(async () => {
      await access(packDir);
      await writeFile(path.join(packDir, 'a-1.0.0.tgz'), 'packed');
      return { stdout: JSON.stringify([{ filename: 'a-1.0.0.tgz' }]), stderr: '' };
    });

    const packed = await packNpm({ packageDir: '/pkg', packDir, runProcess });

    expect(packed.fileName).toBe('a-1.0.0.tgz');
  });

  it('wraps a failing npm pack in a PublishError naming the package directory', async () => {
    const runProcess = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const packDir = await tempDir();
    await expect(packNpm({ packageDir: '/pkg', packDir, runProcess })).rejects.toThrow(
      /npm pack failed in \/pkg: ENOENT/,
    );
  });

  it.each([
    ['not JSON', 'not json'],
    ['an empty list', '[]'],
    ['a list without a filename', '[{}]'],
    ['two tarballs', JSON.stringify([{ filename: 'a.tgz' }, { filename: 'b.tgz' }])],
    ['a path rather than a file name', JSON.stringify([{ filename: '../escape.tgz' }])],
    ['a nested path', JSON.stringify([{ filename: 'sub/a.tgz' }])],
    ['a file that is not a .tgz', JSON.stringify([{ filename: 'a.zip' }])],
  ])('refuses npm pack output that is %s', async (_label, stdout) => {
    const runProcess = vi.fn().mockResolvedValue({ stdout, stderr: '' });
    const packDir = await tempDir();
    await expect(packNpm({ packageDir: '/pkg', packDir, runProcess })).rejects.toThrow(
      PublishError,
    );
  });

  it('refuses a tarball npm named but did not write', async () => {
    const packDir = await tempDir();
    const runProcess = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([{ filename: 'missing-1.0.0.tgz' }]),
      stderr: '',
    });
    await expect(packNpm({ packageDir: '/pkg', packDir, runProcess })).rejects.toThrow(
      PublishError,
    );
  });
});

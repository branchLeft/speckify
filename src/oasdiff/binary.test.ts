import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { pack } from 'tar-stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FetchLike } from '../record/types.js';
import { OasdiffError } from './errors.js';
import { OASDIFF_OVERRIDE_ENV, resolveOasdiffBinary } from './binary.js';

async function makeTarGz(entries: Record<string, string>): Promise<Buffer> {
  const packer = pack();
  for (const [name, content] of Object.entries(entries)) {
    packer.entry({ name }, content);
  }
  packer.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of packer as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return gzipSync(Buffer.concat(chunks));
}

describe('resolveOasdiffBinary', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'speckify-oasdiff-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the override path unconditionally, without fetching', async () => {
    const fetchImpl: FetchLike = vi.fn();
    const result = await resolveOasdiffBinary({
      cacheDir: dir,
      overridePath: '/usr/local/bin/oasdiff',
      fetchImpl,
    });

    expect(result).toBe('/usr/local/bin/oasdiff');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns the cached binary path without fetching when it already exists', async () => {
    const versionDir = join(dir, '1.32.1');
    await mkdir(versionDir, { recursive: true });
    await writeFile(join(versionDir, 'oasdiff'), 'x');

    const fetchImpl: FetchLike = vi.fn();
    const result = await resolveOasdiffBinary({
      cacheDir: dir,
      platform: 'linux',
      arch: 'x64',
      fetchImpl,
    });

    expect(result).toBe(join(versionDir, 'oasdiff'));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws OasdiffError for an unsupported platform', async () => {
    await expect(
      resolveOasdiffBinary({ cacheDir: dir, platform: 'aix', arch: 'x64' }),
    ).rejects.toThrow(OasdiffError);
  });

  it('throws OasdiffError for an unsupported architecture', async () => {
    await expect(
      resolveOasdiffBinary({ cacheDir: dir, platform: 'linux', arch: 'ia32' }),
    ).rejects.toThrow(OasdiffError);
  });

  it('downloads, verifies and extracts the binary when the checksum matches', async () => {
    const tarGz = await makeTarGz({ oasdiff: 'fake-binary-content' });
    const checksum = createHash('sha256').update(tarGz).digest('hex');

    const checksumsPath = join(dir, 'checksums.json');
    await writeFile(
      checksumsPath,
      JSON.stringify({ 'oasdiff_1.32.1_linux_amd64.tar.gz': checksum }),
    );

    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response(new Uint8Array(tarGz), { status: 200 })),
    );

    const result = await resolveOasdiffBinary({
      cacheDir: dir,
      platform: 'linux',
      arch: 'x64',
      checksumsPath,
      fetchImpl,
    });

    expect(result).toBe(join(dir, '1.32.1', 'oasdiff'));
    const stats = await stat(result);
    expect(stats.mode & 0o755).toBe(0o755);
  });

  it('throws OasdiffError when the downloaded checksum does not match', async () => {
    const tarGz = await makeTarGz({ oasdiff: 'fake-binary-content' });
    const checksumsPath = join(dir, 'checksums.json');
    await writeFile(
      checksumsPath,
      JSON.stringify({ 'oasdiff_1.32.1_linux_amd64.tar.gz': 'not-the-real-checksum' }),
    );

    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response(new Uint8Array(tarGz), { status: 200 })),
    );

    await expect(
      resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'linux',
        arch: 'x64',
        checksumsPath,
        fetchImpl,
      }),
    ).rejects.toThrow(/checksum mismatch/);
  });

  it('throws OasdiffError when there is no committed checksum for the asset', async () => {
    const checksumsPath = join(dir, 'checksums.json');
    await writeFile(checksumsPath, JSON.stringify({}));

    await expect(
      resolveOasdiffBinary({ cacheDir: dir, platform: 'linux', arch: 'x64', checksumsPath }),
    ).rejects.toThrow(/no committed checksum/);
  });

  it('throws OasdiffError when the download fails', async () => {
    const checksumsPath = join(dir, 'checksums.json');
    await writeFile(
      checksumsPath,
      JSON.stringify({ 'oasdiff_1.32.1_linux_amd64.tar.gz': 'irrelevant' }),
    );
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response('', { status: 500 })),
    );

    await expect(
      resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'linux',
        arch: 'x64',
        checksumsPath,
        fetchImpl,
      }),
    ).rejects.toThrow(/could not download/);
  });

  it('throws OasdiffError when the archive has no matching binary entry', async () => {
    const tarGz = await makeTarGz({ 'not-oasdiff': 'x' });
    const checksum = createHash('sha256').update(tarGz).digest('hex');
    const checksumsPath = join(dir, 'checksums.json');
    await writeFile(
      checksumsPath,
      JSON.stringify({ 'oasdiff_1.32.1_linux_amd64.tar.gz': checksum }),
    );
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response(new Uint8Array(tarGz), { status: 200 })),
    );

    await expect(
      resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'linux',
        arch: 'x64',
        checksumsPath,
        fetchImpl,
      }),
    ).rejects.toThrow(/has no "oasdiff" entry/);
  });

  it('resolves the darwin universal asset name regardless of arch', async () => {
    const checksumsPath = join(dir, 'checksums.json');
    await writeFile(checksumsPath, JSON.stringify({}));

    await expect(
      resolveOasdiffBinary({ cacheDir: dir, platform: 'darwin', arch: 'arm64', checksumsPath }),
    ).rejects.toThrow(/oasdiff_1\.32\.1_darwin_all\.tar\.gz/);
  });

  it('reads the override from the environment variable when no explicit override is given', async () => {
    const previous = process.env[OASDIFF_OVERRIDE_ENV];
    process.env[OASDIFF_OVERRIDE_ENV] = '/env/oasdiff';
    try {
      const result = await resolveOasdiffBinary({ cacheDir: dir });
      expect(result).toBe('/env/oasdiff');
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, OASDIFF_OVERRIDE_ENV);
      } else {
        process.env[OASDIFF_OVERRIDE_ENV] = previous;
      }
    }
  });
});

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { pack } from 'tar-stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FetchLike } from '../record/types.js';
import { OasdiffError } from './errors.js';
import {
  OASDIFF_OVERRIDE_ENV,
  OASDIFF_OVERRIDE_UNVERIFIED_ENV,
  resolveOasdiffBinary,
} from './binary.js';

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

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

const ASSET = 'oasdiff_1.32.1_linux_amd64.tar.gz';
const BINARY_CONTENT = 'fake-binary-content';
const BINARY_CHECKSUM = sha256(BINARY_CONTENT);

describe('resolveOasdiffBinary', () => {
  let dir: string;
  let checksumsPath: string;
  let binaryChecksumsPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'speckify-oasdiff-'));
    checksumsPath = join(dir, 'checksums.json');
    binaryChecksumsPath = join(dir, 'binary-checksums.json');
    // Every test that needs a valid table starts from one keyed for the
    // linux/amd64 asset with the real checksum of a fresh tar.gz built from
    // BINARY_CONTENT; individual tests overwrite this where they need to.
    const tarGz = await makeTarGz({ oasdiff: BINARY_CONTENT });
    await writeFile(checksumsPath, JSON.stringify({ [ASSET]: sha256Buffer(tarGz) }));
    await writeFile(binaryChecksumsPath, JSON.stringify({ [ASSET]: BINARY_CHECKSUM }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function sha256Buffer(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  it('returns the override path after verifying its checksum, without fetching', async () => {
    const overridePath = join(dir, 'my-oasdiff');
    await writeFile(overridePath, BINARY_CONTENT);
    const fetchImpl: FetchLike = vi.fn();

    const result = await resolveOasdiffBinary({
      cacheDir: dir,
      platform: 'linux',
      arch: 'x64',
      overridePath,
      checksumsPath,
      binaryChecksumsPath,
      fetchImpl,
    });

    expect(result).toBe(overridePath);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an override binary whose checksum does not match the committed table', async () => {
    const overridePath = join(dir, 'my-oasdiff');
    await writeFile(overridePath, 'tampered-content');

    await expect(
      resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'linux',
        arch: 'x64',
        overridePath,
        checksumsPath,
        binaryChecksumsPath,
      }),
    ).rejects.toThrow(/checksum mismatch/);
  });

  it('skips override checksum verification and warns when SPECKIFY_OASDIFF_UNVERIFIED=1', async () => {
    const overridePath = join(dir, 'my-oasdiff');
    await writeFile(overridePath, 'tampered-content');
    const warn = vi.fn();

    const result = await resolveOasdiffBinary({
      cacheDir: dir,
      platform: 'linux',
      arch: 'x64',
      overridePath,
      overrideUnverified: true,
      checksumsPath,
      binaryChecksumsPath,
      warn,
    });

    expect(result).toBe(overridePath);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unverified/i));
  });

  it('reads the unverified-override flag from the environment variable', async () => {
    const overridePath = join(dir, 'my-oasdiff');
    await writeFile(overridePath, 'tampered-content');
    const previous = process.env[OASDIFF_OVERRIDE_UNVERIFIED_ENV];
    process.env[OASDIFF_OVERRIDE_UNVERIFIED_ENV] = '1';
    try {
      const result = await resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'linux',
        arch: 'x64',
        overridePath,
        checksumsPath,
        binaryChecksumsPath,
        warn: vi.fn(),
      });
      expect(result).toBe(overridePath);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, OASDIFF_OVERRIDE_UNVERIFIED_ENV);
      } else {
        process.env[OASDIFF_OVERRIDE_UNVERIFIED_ENV] = previous;
      }
    }
  });

  it('returns the cached binary path without fetching when its checksum matches', async () => {
    const versionDir = join(dir, '1.32.1');
    await mkdir(versionDir, { recursive: true });
    await writeFile(join(versionDir, 'oasdiff'), BINARY_CONTENT);

    const fetchImpl: FetchLike = vi.fn();
    const result = await resolveOasdiffBinary({
      cacheDir: dir,
      platform: 'linux',
      arch: 'x64',
      checksumsPath,
      binaryChecksumsPath,
      fetchImpl,
    });

    expect(result).toBe(join(versionDir, 'oasdiff'));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a tampered cache and re-downloads a fresh, re-verified binary', async () => {
    const versionDir = join(dir, '1.32.1');
    await mkdir(versionDir, { recursive: true });
    // A cached binary that no longer matches the committed checksum -- as
    // if the cache directory had been tampered with after a prior
    // resolution wrote and verified it.
    await writeFile(join(versionDir, 'oasdiff'), 'tampered-on-disk-content');

    const tarGz = await makeTarGz({ oasdiff: BINARY_CONTENT });
    await writeFile(checksumsPath, JSON.stringify({ [ASSET]: sha256Buffer(tarGz) }));
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response(new Uint8Array(tarGz), { status: 200 })),
    );

    const result = await resolveOasdiffBinary({
      cacheDir: dir,
      platform: 'linux',
      arch: 'x64',
      checksumsPath,
      binaryChecksumsPath,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toBe(join(versionDir, 'oasdiff'));
    const rewritten = await readFile(result, 'utf8');
    expect(rewritten).toBe(BINARY_CONTENT);
  });

  it('throws OasdiffError for an unsupported platform', async () => {
    await expect(
      resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'aix',
        arch: 'x64',
        checksumsPath,
        binaryChecksumsPath,
      }),
    ).rejects.toThrow(OasdiffError);
  });

  it('throws OasdiffError for an unsupported architecture', async () => {
    await expect(
      resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'linux',
        arch: 'ia32',
        checksumsPath,
        binaryChecksumsPath,
      }),
    ).rejects.toThrow(OasdiffError);
  });

  it('downloads, verifies and extracts the binary when both checksums match', async () => {
    const tarGz = await makeTarGz({ oasdiff: BINARY_CONTENT });
    await writeFile(checksumsPath, JSON.stringify({ [ASSET]: sha256Buffer(tarGz) }));

    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response(new Uint8Array(tarGz), { status: 200 })),
    );

    const result = await resolveOasdiffBinary({
      cacheDir: dir,
      platform: 'linux',
      arch: 'x64',
      checksumsPath,
      binaryChecksumsPath,
      fetchImpl,
    });

    expect(result).toBe(join(dir, '1.32.1', 'oasdiff'));
    const stats = await stat(result);
    expect(stats.mode & 0o755).toBe(0o755);
  });

  it('never leaves a partial file at the final binary path (writes via temp file + rename)', async () => {
    const tarGz = await makeTarGz({ oasdiff: BINARY_CONTENT });
    await writeFile(checksumsPath, JSON.stringify({ [ASSET]: sha256Buffer(tarGz) }));

    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response(new Uint8Array(tarGz), { status: 200 })),
    );

    await resolveOasdiffBinary({
      cacheDir: dir,
      platform: 'linux',
      arch: 'x64',
      checksumsPath,
      binaryChecksumsPath,
      fetchImpl,
    });

    const versionDir = join(dir, '1.32.1');
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(versionDir);
    expect(entries).toEqual(['oasdiff']);
  });

  it('throws OasdiffError when the downloaded archive checksum does not match', async () => {
    const tarGz = await makeTarGz({ oasdiff: BINARY_CONTENT });
    await writeFile(checksumsPath, JSON.stringify({ [ASSET]: 'not-the-real-checksum' }));

    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response(new Uint8Array(tarGz), { status: 200 })),
    );

    await expect(
      resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'linux',
        arch: 'x64',
        checksumsPath,
        binaryChecksumsPath,
        fetchImpl,
      }),
    ).rejects.toThrow(/checksum mismatch/);
  });

  it('throws OasdiffError when the extracted binary does not match the committed binary checksum', async () => {
    // The archive checksum matches (so extraction proceeds), but the
    // binary-checksums.json table has a different, unrelated value --
    // simulating a compromised or stale binary-checksum table.
    const tarGz = await makeTarGz({ oasdiff: BINARY_CONTENT });
    await writeFile(checksumsPath, JSON.stringify({ [ASSET]: sha256Buffer(tarGz) }));
    await writeFile(binaryChecksumsPath, JSON.stringify({ [ASSET]: sha256('something-else') }));

    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response(new Uint8Array(tarGz), { status: 200 })),
    );

    await expect(
      resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'linux',
        arch: 'x64',
        checksumsPath,
        binaryChecksumsPath,
        fetchImpl,
      }),
    ).rejects.toThrow(/checksum mismatch for the oasdiff binary/);
  });

  it('throws OasdiffError when there is no committed archive checksum for the asset', async () => {
    await writeFile(checksumsPath, JSON.stringify({}));

    await expect(
      resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'linux',
        arch: 'x64',
        checksumsPath,
        binaryChecksumsPath,
      }),
    ).rejects.toThrow(/no committed checksum/);
  });

  it('throws OasdiffError when there is no committed binary checksum for the asset', async () => {
    await writeFile(binaryChecksumsPath, JSON.stringify({}));

    await expect(
      resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'linux',
        arch: 'x64',
        checksumsPath,
        binaryChecksumsPath,
      }),
    ).rejects.toThrow(/no committed binary checksum/);
  });

  it('throws OasdiffError when the download fails', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response('', { status: 500 })),
    );

    await expect(
      resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'linux',
        arch: 'x64',
        checksumsPath,
        binaryChecksumsPath,
        fetchImpl,
      }),
    ).rejects.toThrow(/could not download/);
  });

  it('throws OasdiffError when the archive has no matching binary entry', async () => {
    const tarGz = await makeTarGz({ 'not-oasdiff': 'x' });
    await writeFile(checksumsPath, JSON.stringify({ [ASSET]: sha256Buffer(tarGz) }));
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response(new Uint8Array(tarGz), { status: 200 })),
    );

    await expect(
      resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'linux',
        arch: 'x64',
        checksumsPath,
        binaryChecksumsPath,
        fetchImpl,
      }),
    ).rejects.toThrow(/has no "oasdiff" entry/);
  });

  it('resolves the darwin universal asset name regardless of arch', async () => {
    await writeFile(checksumsPath, JSON.stringify({}));
    await writeFile(binaryChecksumsPath, JSON.stringify({}));

    await expect(
      resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'darwin',
        arch: 'arm64',
        checksumsPath,
        binaryChecksumsPath,
      }),
    ).rejects.toThrow(/oasdiff_1\.32\.1_darwin_all\.tar\.gz/);
  });

  it('resolves the linux arm64 asset name, distinct from amd64', async () => {
    await writeFile(checksumsPath, JSON.stringify({}));
    await writeFile(binaryChecksumsPath, JSON.stringify({}));

    await expect(
      resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'linux',
        arch: 'arm64',
        checksumsPath,
        binaryChecksumsPath,
      }),
    ).rejects.toThrow(/oasdiff_1\.32\.1_linux_arm64\.tar\.gz/);
  });

  it('resolves the windows asset name and binary filename', async () => {
    await writeFile(checksumsPath, JSON.stringify({}));
    await writeFile(binaryChecksumsPath, JSON.stringify({}));

    await expect(
      resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'win32',
        arch: 'x64',
        checksumsPath,
        binaryChecksumsPath,
      }),
    ).rejects.toThrow(/oasdiff_1\.32\.1_windows_amd64\.tar\.gz/);
  });

  it('falls back to the committed checksums.json/binary-checksums.json when no paths are given', async () => {
    // No checksumsPath/binaryChecksumsPath: this exercises the real, shipped
    // tables, whose committed hash for this fake archive will never match.
    const tarGz = await makeTarGz({ oasdiff: BINARY_CONTENT });
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response(new Uint8Array(tarGz), { status: 200 })),
    );

    await expect(
      resolveOasdiffBinary({ cacheDir: dir, platform: 'linux', arch: 'x64', fetchImpl }),
    ).rejects.toThrow(/checksum mismatch/);
  });

  it('reads the override from the environment variable when no explicit override is given', async () => {
    const overridePath = join(dir, 'env-oasdiff');
    await writeFile(overridePath, BINARY_CONTENT);
    const previous = process.env[OASDIFF_OVERRIDE_ENV];
    process.env[OASDIFF_OVERRIDE_ENV] = overridePath;
    try {
      const result = await resolveOasdiffBinary({
        cacheDir: dir,
        platform: 'linux',
        arch: 'x64',
        checksumsPath,
        binaryChecksumsPath,
      });
      expect(result).toBe(overridePath);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, OASDIFF_OVERRIDE_ENV);
      } else {
        process.env[OASDIFF_OVERRIDE_ENV] = previous;
      }
    }
  });
});

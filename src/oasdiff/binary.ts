import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { arch as hostArch, platform as hostPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractTarGzEntry } from '../record/extract-tar-entry.js';
import { OasdiffError } from './errors.js';
import { OASDIFF_VERSION } from './version.js';
import type { FetchLike } from '../record/types.js';

export { OASDIFF_VERSION } from './version.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultChecksumsPath = join(moduleDir, 'checksums.json');
const defaultBinaryChecksumsPath = join(moduleDir, 'binary-checksums.json');

/** The environment variable that, if set, is used as the oasdiff binary path directly. */
export const OASDIFF_OVERRIDE_ENV = 'SPECKIFY_OASDIFF';

/**
 * The environment variable that, if set to `1`, skips checksum verification
 * of the {@link OASDIFF_OVERRIDE_ENV} binary. Prints a warning either way.
 */
export const OASDIFF_OVERRIDE_UNVERIFIED_ENV = 'SPECKIFY_OASDIFF_UNVERIFIED';

function assetName(platform: string, arch: string): string {
  if (platform === 'darwin') {
    // oasdiff publishes one universal binary for macOS, not one per arch.
    return `oasdiff_${OASDIFF_VERSION}_darwin_all.tar.gz`;
  }
  const archName = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
  if (archName === null) {
    throw new OasdiffError(`oasdiff has no published build for architecture "${arch}"`);
  }
  if (platform === 'linux') {
    return `oasdiff_${OASDIFF_VERSION}_linux_${archName}.tar.gz`;
  }
  if (platform === 'win32') {
    return `oasdiff_${OASDIFF_VERSION}_windows_${archName}.tar.gz`;
  }
  throw new OasdiffError(`oasdiff has no published build for platform "${platform}"`);
}

async function loadJson(path: string): Promise<Record<string, string>> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as Record<string, string>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const buffer = await readFile(path);
  return createHash('sha256').update(buffer).digest('hex');
}

export interface ResolveOasdiffOptions {
  /** Where a downloaded binary is cached, keyed by version. */
  cacheDir: string;
  fetchImpl?: FetchLike;
  /** Overrides `process.platform` for tests; defaults to the host platform. */
  platform?: string;
  /** Overrides `process.arch` for tests; defaults to the host architecture. */
  arch?: string;
  /** Overrides `process.env[OASDIFF_OVERRIDE_ENV]` for tests. */
  overridePath?: string;
  /** Overrides `process.env[OASDIFF_OVERRIDE_UNVERIFIED_ENV]` for tests. */
  overrideUnverified?: boolean;
  /** Overrides the committed archive checksum table's path for tests. */
  checksumsPath?: string;
  /** Overrides the committed extracted-binary checksum table's path for tests. */
  binaryChecksumsPath?: string;
  /** Where warnings (e.g. an unverified override) are printed; defaults to `console.error`. */
  warn?: (message: string) => void;
}

/**
 * Resolves the path to a working oasdiff {@link OASDIFF_VERSION} binary.
 * Resolution order and the trust model behind it: see `binary.md`.
 *
 * @throws {OasdiffError} if the platform has no published build, the
 * download fails, or a checksum does not match -- including a cached or
 * overridden binary that no longer matches the committed table, which is
 * treated as tampered rather than trusted.
 */
export async function resolveOasdiffBinary(options: ResolveOasdiffOptions): Promise<string> {
  const platform = options.platform ?? hostPlatform();
  const arch = options.arch ?? hostArch();
  const warn = options.warn ?? ((message: string) => console.error(message));
  const asset = assetName(platform, arch);

  const binaryChecksums = await loadJson(
    options.binaryChecksumsPath ?? defaultBinaryChecksumsPath,
  );
  const expectedBinaryChecksum = binaryChecksums[asset];
  if (expectedBinaryChecksum === undefined) {
    throw new OasdiffError(`no committed binary checksum for oasdiff asset "${asset}"`);
  }

  const overridePath = options.overridePath ?? process.env[OASDIFF_OVERRIDE_ENV];
  if (overridePath !== undefined && overridePath !== '') {
    const unverified =
      options.overrideUnverified ?? process.env[OASDIFF_OVERRIDE_UNVERIFIED_ENV] === '1';
    if (unverified) {
      warn(
        `SPECKIFY_OASDIFF_UNVERIFIED=1: using "${overridePath}" as the oasdiff binary without checksum verification.`,
      );
      return overridePath;
    }
    const actualChecksum = await sha256OfFile(overridePath);
    if (actualChecksum !== expectedBinaryChecksum) {
      throw new OasdiffError(
        `checksum mismatch for ${OASDIFF_OVERRIDE_ENV}="${overridePath}": expected ${expectedBinaryChecksum}, got ${actualChecksum} (set ${OASDIFF_OVERRIDE_UNVERIFIED_ENV}=1 to bypass)`,
      );
    }
    return overridePath;
  }

  const versionDir = join(options.cacheDir, OASDIFF_VERSION);
  const binaryName = platform === 'win32' ? 'oasdiff.exe' : 'oasdiff';
  const binaryPath = join(versionDir, binaryName);

  if (await exists(binaryPath)) {
    const actualChecksum = await sha256OfFile(binaryPath);
    if (actualChecksum === expectedBinaryChecksum) {
      return binaryPath;
    }
    // The cached binary no longer matches the committed checksum -- refuse
    // it and fall through to a fresh, re-verified download rather than
    // trusting or silently overwriting it.
    await rm(binaryPath, { force: true });
  }

  const checksums = await loadJson(options.checksumsPath ?? defaultChecksumsPath);
  const expectedArchiveChecksum = checksums[asset];
  if (expectedArchiveChecksum === undefined) {
    throw new OasdiffError(`no committed checksum for oasdiff asset "${asset}"`);
  }

  const downloadUrl = `https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}/${asset}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(downloadUrl);
  if (!response.ok) {
    throw new OasdiffError(`could not download ${downloadUrl}: ${String(response.status)}`);
  }
  const archiveBuffer = Buffer.from(await response.arrayBuffer());

  const actualArchiveChecksum = createHash('sha256').update(archiveBuffer).digest('hex');
  if (actualArchiveChecksum !== expectedArchiveChecksum) {
    throw new OasdiffError(
      `checksum mismatch for ${asset}: expected ${expectedArchiveChecksum}, got ${actualArchiveChecksum}`,
    );
  }

  const binaryBuffer = await extractTarGzEntry(
    archiveBuffer,
    (entryName) => entryName === binaryName,
  );
  if (binaryBuffer === null) {
    throw new OasdiffError(`archive ${asset} has no "${binaryName}" entry`);
  }

  const actualBinaryChecksum = createHash('sha256').update(binaryBuffer).digest('hex');
  if (actualBinaryChecksum !== expectedBinaryChecksum) {
    throw new OasdiffError(
      `checksum mismatch for the oasdiff binary extracted from ${asset}: expected ${expectedBinaryChecksum}, got ${actualBinaryChecksum}`,
    );
  }

  await mkdir(versionDir, { recursive: true });
  // Write to a temp file in the same directory, then atomically rename it
  // into place -- a reader (or a concurrent resolveOasdiffBinary call) can
  // never observe a partially written binary at `binaryPath`.
  const tempPath = join(versionDir, `.${binaryName}.${randomBytes(8).toString('hex')}.tmp`);
  await writeFile(tempPath, binaryBuffer);
  await chmod(tempPath, 0o755);
  await rename(tempPath, binaryPath);

  return binaryPath;
}

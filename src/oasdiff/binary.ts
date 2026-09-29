import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { arch as hostArch, platform as hostPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractTarGzEntry } from '../record/extract-tar-entry.js';
import { OasdiffError } from './errors.js';
import { OASDIFF_VERSION } from './version.js';
import type { FetchLike } from '../record/types.js';

export { OASDIFF_VERSION } from './version.js';

const defaultChecksumsPath = join(dirname(fileURLToPath(import.meta.url)), 'checksums.json');

/** The environment variable that, if set, is used as the oasdiff binary path directly. */
export const OASDIFF_OVERRIDE_ENV = 'SPECKIFY_OASDIFF';

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

async function loadChecksums(path: string): Promise<Record<string, string>> {
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
  /** Overrides the committed checksum table's path for tests. */
  checksumsPath?: string;
}

/**
 * Resolves the path to a working oasdiff {@link OASDIFF_VERSION} binary.
 *
 * Resolution order: `SPECKIFY_OASDIFF` env var, unconditionally trusted;
 * otherwise the version's cache directory; otherwise a download from the
 * GitHub release, verified against the committed SHA-256 table before it is
 * ever executed.
 *
 * @throws {OasdiffError} if the platform has no published build, the
 * download fails, or its checksum does not match.
 */
export async function resolveOasdiffBinary(options: ResolveOasdiffOptions): Promise<string> {
  const overridePath = options.overridePath ?? process.env[OASDIFF_OVERRIDE_ENV];
  if (overridePath !== undefined && overridePath !== '') {
    return overridePath;
  }

  const platform = options.platform ?? hostPlatform();
  const arch = options.arch ?? hostArch();
  const fetchImpl = options.fetchImpl ?? fetch;
  const asset = assetName(platform, arch);

  const versionDir = join(options.cacheDir, OASDIFF_VERSION);
  const binaryName = platform === 'win32' ? 'oasdiff.exe' : 'oasdiff';
  const binaryPath = join(versionDir, binaryName);

  if (await exists(binaryPath)) {
    return binaryPath;
  }

  const checksums = await loadChecksums(options.checksumsPath ?? defaultChecksumsPath);
  const expectedChecksum = checksums[asset];
  if (expectedChecksum === undefined) {
    throw new OasdiffError(`no committed checksum for oasdiff asset "${asset}"`);
  }

  const downloadUrl = `https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}/${asset}`;
  const response = await fetchImpl(downloadUrl);
  if (!response.ok) {
    throw new OasdiffError(`could not download ${downloadUrl}: ${String(response.status)}`);
  }
  const archiveBuffer = Buffer.from(await response.arrayBuffer());

  const actualChecksum = createHash('sha256').update(archiveBuffer).digest('hex');
  if (actualChecksum !== expectedChecksum) {
    throw new OasdiffError(
      `checksum mismatch for ${asset}: expected ${expectedChecksum}, got ${actualChecksum}`,
    );
  }

  const binaryBuffer = await extractTarGzEntry(
    archiveBuffer,
    (entryName) => entryName === binaryName,
  );
  if (binaryBuffer === null) {
    throw new OasdiffError(`archive ${asset} has no "${binaryName}" entry`);
  }

  await mkdir(versionDir, { recursive: true });
  await writeFile(binaryPath, binaryBuffer);
  await chmod(binaryPath, 0o755);

  return binaryPath;
}

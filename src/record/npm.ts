import { createHash } from 'node:crypto';

import { compare, valid } from 'semver';

import { toCanonicalJson } from '../bundle/canonical-json.js';
import { RecordError } from './errors.js';
import { extractTarGzEntry } from './extract-tar-entry.js';
import type { FetchLike, RegistryRecord, RegistryRecordEntry } from './types.js';

export interface NpmRegistryOptions {
  /** The npm-compatible registry base URL, e.g. GitHub Packages' `https://npm.pkg.github.com`. */
  registryUrl: string;
  /** A bearer token for a registry that requires auth, such as GitHub Packages. */
  token?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  /** Abort any single registry request that runs longer than this. */
  timeoutMs?: number | undefined;
}

const DEFAULT_REGISTRY_TIMEOUT_MS = 30_000;

interface NpmPackument {
  'dist-tags'?: { latest?: string };
  versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }>;
}

function isNpmPackument(value: unknown): value is NpmPackument {
  return typeof value === 'object' && value !== null;
}

/** Subresource Integrity algorithms accepted for `dist.integrity`, weakest first. */
const SRI_ALGORITHMS = ['sha256', 'sha384', 'sha512'] as const;

/**
 * Whether `data` matches an SRI string (`sha512-<base64>`, possibly several
 * space-separated). Only the strongest supported algorithm present is
 * consulted, so a weak digest alongside a strong one cannot satisfy it.
 * A string naming no supported algorithm never matches.
 */
function matchesIntegrity(data: Buffer, integrity: string): boolean {
  const tokens = integrity
    .split(/\s+/)
    .filter((token) => token !== '')
    .map((token) => {
      const dash = token.indexOf('-');
      return { algorithm: token.slice(0, dash), digest: token.slice(dash + 1) };
    });
  for (const algorithm of [...SRI_ALGORITHMS].reverse()) {
    const candidates = tokens.filter((token) => token.algorithm === algorithm);
    if (candidates.length > 0) {
      const actual = createHash(algorithm).update(data).digest('base64');
      return candidates.some((token) => token.digest === actual);
    }
  }
  return false;
}

/** The origin of an http(s) URL, or `null` for anything else (an opaque origin must never compare equal). */
function httpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The highest valid semver among a packument's own `versions` keys.
 * `dist-tags.latest` is a separately-set, mutable pointer -- a republish of
 * an old version, a manual `npm dist-tag` slip, or a registry quirk can
 * leave it behind what's actually the highest published version. "The
 * registry is the record" means computing the true highest version, the
 * same way `reconcile.ts` already does across targets, not trusting a tag
 * that can drift from it.
 */
function highestPublishedVersion(packument: NpmPackument): string | null {
  const versions = Object.keys(packument.versions ?? {}).filter((version) => valid(version));
  if (versions.length === 0) {
    return null;
  }
  return versions.reduce((highest, candidate) =>
    compare(candidate, highest) > 0 ? candidate : highest,
  );
}

/** Reads the generating Speckify version back from a downloaded package.json's `speckify.speckifyVersion`. */
function speckifyVersionFromPackageJson(raw: Buffer | null): string | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const speckify = (parsed as { speckify?: unknown }).speckify;
    if (typeof speckify !== 'object' || speckify === null) {
      return null;
    }
    const version = (speckify as { speckifyVersion?: unknown }).speckifyVersion;
    return typeof version === 'string' ? version : null;
  } catch {
    // A package predating this field, or one whose package.json cannot be
    // parsed for any other reason, has an unknown generating version -- not
    // an absent one. Callers must fail safe on `null` here, never read it
    // as "never generated before".
    return null;
  }
}

/**
 * A {@link RegistryRecord} backed by an npm-compatible registry: reads the
 * package's packument for `dist-tags.latest`, then downloads that version's
 * tarball and extracts the `openapi.json` it published alongside it.
 */
export function createNpmRegistryRecord(options: NpmRegistryOptions): RegistryRecord {
  const fetchImpl = options.fetchImpl ?? fetch;
  const registryUrl = options.registryUrl.replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;

  const registryOrigin = httpOrigin(registryUrl);

  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.token !== undefined && options.token !== '') {
      headers.Authorization = `Bearer ${options.token}`;
    }
    return headers;
  }

  /** One registry request, aborted after the timeout so a stalled registry cannot hang the plan. */
  async function fetchWithTimeout(url: string): Promise<Response> {
    try {
      return await fetchImpl(url, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RecordError(`npm registry request to ${url} failed: ${reason}`);
    }
  }

  /** Reads a response body; a stall or failure there is a RecordError naming the URL too. */
  async function readBody<T>(url: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RecordError(`npm registry response from ${url} could not be read: ${reason}`);
    }
  }

  async function latest(packageName: string): Promise<RegistryRecordEntry | null> {
    const packumentUrl = `${registryUrl}/${encodeURIComponent(packageName)}`;
    const response = await fetchWithTimeout(packumentUrl);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new RecordError(
        `npm registry returned ${String(response.status)} for "${packageName}"`,
      );
    }

    const packument: unknown = await readBody(packumentUrl, () => response.json());
    if (!isNpmPackument(packument)) {
      throw new RecordError(`npm registry returned a malformed packument for "${packageName}"`);
    }

    const version = highestPublishedVersion(packument);
    if (version === null) {
      throw new RecordError(
        `npm registry packument for "${packageName}" has no published versions`,
      );
    }

    const tarballUrl = packument.versions?.[version]?.dist?.tarball;
    if (tarballUrl === undefined) {
      throw new RecordError(
        `npm registry packument for "${packageName}"@${version} has no dist.tarball`,
      );
    }

    // The packument names the tarball URL, so it is untrusted input: the
    // bearer token must never leave the registry's own origin.
    if (registryOrigin === null || httpOrigin(tarballUrl) !== registryOrigin) {
      throw new RecordError(
        `npm registry packument for "${packageName}"@${version} points its tarball at ${tarballUrl}, which is not on the registry origin; refusing to send the token there`,
      );
    }

    const tarballResponse = await fetchWithTimeout(tarballUrl);
    if (!tarballResponse.ok) {
      throw new RecordError(
        `could not download tarball for "${packageName}"@${version}: ${String(tarballResponse.status)}`,
      );
    }
    const tarballBuffer = Buffer.from(
      await readBody(tarballUrl, () => tarballResponse.arrayBuffer()),
    );

    const integrity = packument.versions?.[version]?.dist?.integrity;
    if (integrity !== undefined && !matchesIntegrity(tarballBuffer, integrity)) {
      throw new RecordError(
        `tarball for "${packageName}"@${version} from ${tarballUrl} does not match its packument integrity`,
      );
    }

    const specBuffer = await extractTarGzEntry(
      tarballBuffer,
      (entryName) => entryName === 'package/openapi.json',
    );
    if (specBuffer === null) {
      throw new RecordError(
        `published tarball for "${packageName}"@${version} has no package/openapi.json`,
      );
    }

    const packageJsonBuffer = await extractTarGzEntry(
      tarballBuffer,
      (entryName) => entryName === 'package/package.json',
    );

    const spec: unknown = JSON.parse(specBuffer.toString('utf8'));
    return {
      version,
      bundledSpec: toCanonicalJson(spec),
      speckifyVersion: speckifyVersionFromPackageJson(packageJsonBuffer),
    };
  }

  return { latest };
}

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
}

interface NpmPackument {
  'dist-tags'?: { latest?: string };
  versions?: Record<string, { dist?: { tarball?: string } }>;
}

function isNpmPackument(value: unknown): value is NpmPackument {
  return typeof value === 'object' && value !== null;
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

  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.token !== undefined && options.token !== '') {
      headers.Authorization = `Bearer ${options.token}`;
    }
    return headers;
  }

  async function latest(packageName: string): Promise<RegistryRecordEntry | null> {
    const packumentUrl = `${registryUrl}/${encodeURIComponent(packageName)}`;
    const response = await fetchImpl(packumentUrl, { headers: authHeaders() });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new RecordError(
        `npm registry returned ${String(response.status)} for "${packageName}"`,
      );
    }

    const packument: unknown = await response.json();
    if (!isNpmPackument(packument)) {
      throw new RecordError(`npm registry returned a malformed packument for "${packageName}"`);
    }

    const version = packument['dist-tags']?.latest;
    if (version === undefined) {
      throw new RecordError(`npm registry packument for "${packageName}" has no dist-tags.latest`);
    }

    const tarballUrl = packument.versions?.[version]?.dist?.tarball;
    if (tarballUrl === undefined) {
      throw new RecordError(
        `npm registry packument for "${packageName}"@${version} has no dist.tarball`,
      );
    }

    const tarballResponse = await fetchImpl(tarballUrl, { headers: authHeaders() });
    if (!tarballResponse.ok) {
      throw new RecordError(
        `could not download tarball for "${packageName}"@${version}: ${String(tarballResponse.status)}`,
      );
    }
    const tarballBuffer = Buffer.from(await tarballResponse.arrayBuffer());

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

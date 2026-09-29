import { toCanonicalJson } from '../bundle/canonical-json.js';
import { RecordError } from './errors.js';
import { extractZipEntry } from './extract-zip-entry.js';
import type { FetchLike, RegistryRecord, RegistryRecordEntry } from './types.js';

export interface PyPiRegistryOptions {
  /** The PyPI-compatible index base URL. Defaults to `https://pypi.org`. */
  indexUrl?: string | undefined;
  fetchImpl?: FetchLike | undefined;
}

interface PyPiRelease {
  packagetype?: string;
  url?: string;
}

interface PyPiProjectResponse {
  info?: { version?: string };
  urls?: PyPiRelease[];
}

function isPyPiProjectResponse(value: unknown): value is PyPiProjectResponse {
  return typeof value === 'object' && value !== null;
}

/**
 * A {@link RegistryRecord} backed by PyPI's JSON API: reads the project's
 * current version, then downloads that version's wheel and extracts the
 * `openapi.json` it published alongside it.
 */
export function createPyPiRegistryRecord(options: PyPiRegistryOptions = {}): RegistryRecord {
  const fetchImpl = options.fetchImpl ?? fetch;
  const indexUrl = (options.indexUrl ?? 'https://pypi.org').replace(/\/$/, '');

  async function latest(packageName: string): Promise<RegistryRecordEntry | null> {
    const projectUrl = `${indexUrl}/pypi/${encodeURIComponent(packageName)}/json`;
    const response = await fetchImpl(projectUrl);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new RecordError(`PyPI returned ${String(response.status)} for "${packageName}"`);
    }

    const project: unknown = await response.json();
    if (!isPyPiProjectResponse(project)) {
      throw new RecordError(`PyPI returned a malformed project response for "${packageName}"`);
    }

    const version = project.info?.version;
    if (version === undefined) {
      throw new RecordError(`PyPI project response for "${packageName}" has no info.version`);
    }

    const wheel = (project.urls ?? []).find((release) => release.packagetype === 'bdist_wheel');
    if (wheel?.url === undefined) {
      throw new RecordError(
        `PyPI project response for "${packageName}"@${version} has no wheel release`,
      );
    }

    const wheelResponse = await fetchImpl(wheel.url);
    if (!wheelResponse.ok) {
      throw new RecordError(
        `could not download wheel for "${packageName}"@${version}: ${String(wheelResponse.status)}`,
      );
    }
    const wheelBuffer = Buffer.from(await wheelResponse.arrayBuffer());

    const specBuffer = await extractZipEntry(
      wheelBuffer,
      (entryName) => entryName === 'openapi.json' || entryName.endsWith('/openapi.json'),
    );
    if (specBuffer === null) {
      throw new RecordError(`published wheel for "${packageName}"@${version} has no openapi.json`);
    }

    const spec: unknown = JSON.parse(specBuffer.toString('utf8'));
    return { version, bundledSpec: toCanonicalJson(spec) };
  }

  return { latest };
}

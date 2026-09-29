import { OASDIFF_VERSION } from '../oasdiff/version.js';
import { VersionError } from './errors.js';
import { readJsonFile } from './json-file.js';
import { coveredKeywordsFileSchema } from './types.js';

export interface LoadCoveredKeywordsOptions {
  /** Overridden only in tests; defaults to the oasdiff version Speckify is pinned to. */
  expectedOasdiffVersion?: string;
}

/**
 * Loads and validates the committed covered-keywords file enumerating every
 * JSON-Schema/OpenAPI keyword oasdiff's rule catalogue judges. plan.ts's
 * structural fallback uses this to force major bumps for unclassified changes.
 * @throws {VersionError} if the file cannot be read/parsed, fails schema
 * validation, or version mismatch with OASDIFF_VERSION. See covered-keywords.md.
 */
export async function loadCoveredKeywords(
  filePath: string,
  options: LoadCoveredKeywordsOptions = {},
): Promise<ReadonlySet<string>> {
  const expectedOasdiffVersion = options.expectedOasdiffVersion ?? OASDIFF_VERSION;

  const raw = await readJsonFile(filePath);
  const result = coveredKeywordsFileSchema.safeParse(raw);
  if (!result.success) {
    throw new VersionError(
      `${filePath} is not a valid covered-keywords file: ${result.error.message}`,
    );
  }
  const file = result.data;

  if (file.oasdiffVersion !== expectedOasdiffVersion) {
    throw new VersionError(
      `${filePath} is pinned to oasdiff ${file.oasdiffVersion}, but Speckify is pinned to ${expectedOasdiffVersion}; regenerate the covered-keywords file (scripts/generate-oasdiff-covered-keywords.mjs) before upgrading oasdiff`,
    );
  }

  return new Set(file.keywords);
}

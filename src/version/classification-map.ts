import { OASDIFF_VERSION } from '../oasdiff/version.js';
import { VersionError } from './errors.js';
import { readJsonFile } from './json-file.js';
import {
  classificationMapFileSchema,
  oasdiffCheckCatalogueSchema,
  type ClassificationMap,
} from './types.js';

export interface LoadClassificationMapOptions {
  /** Overridden only in tests; defaults to the oasdiff version Speckify is pinned to. */
  expectedOasdiffVersion?: string;
}

/**
 * Loads and validates the committed classification map
 * (`data/oasdiff-<version>.classification.json`): every oasdiff rule id
 * judged from an existing client's perspective, reduced to the
 * id → {@link Bump} lookup `classify` uses.
 *
 * @throws {VersionError} if the file cannot be read or parsed, fails schema
 * validation, is pinned to a different oasdiff version than Speckify's own
 * {@link OASDIFF_VERSION}, or declares the same rule id twice.
 */
export async function loadClassificationMap(
  filePath: string,
  options: LoadClassificationMapOptions = {},
): Promise<ClassificationMap> {
  const expectedOasdiffVersion = options.expectedOasdiffVersion ?? OASDIFF_VERSION;

  const raw = await readJsonFile(filePath);
  const result = classificationMapFileSchema.safeParse(raw);
  if (!result.success) {
    throw new VersionError(
      `${filePath} is not a valid classification map: ${result.error.message}`,
    );
  }
  const file = result.data;

  if (file.oasdiffVersion !== expectedOasdiffVersion) {
    throw new VersionError(
      `${filePath} is pinned to oasdiff ${file.oasdiffVersion}, but Speckify is pinned to ${expectedOasdiffVersion}; regenerate the classification map (and the rule catalogue) before upgrading oasdiff`,
    );
  }

  const map: ClassificationMap = {};
  for (const rule of file.rules) {
    if (Object.prototype.hasOwnProperty.call(map, rule.id)) {
      throw new VersionError(`${filePath} declares rule id "${rule.id}" more than once`);
    }
    map[rule.id] = rule.bump;
  }

  return map;
}

/**
 * Loads and validates the committed oasdiff rule catalogue
 * (`data/oasdiff-<version>.checks.json`, the output of oasdiff's own
 * `checks changelog --format json`), returning just the set of rule ids it
 * declares.
 *
 * @throws {VersionError} if the file cannot be read or parsed, or fails
 * schema validation.
 */
export async function loadOasdiffCheckIds(filePath: string): Promise<Set<string>> {
  const raw = await readJsonFile(filePath);
  const result = oasdiffCheckCatalogueSchema.safeParse(raw);
  if (!result.success) {
    throw new VersionError(
      `${filePath} is not a valid oasdiff check catalogue: ${result.error.message}`,
    );
  }
  return new Set(result.data.map((check) => check.id));
}

import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

import { $RefParser } from '@apidevtools/json-schema-ref-parser';

import { toCanonicalJson } from './canonical-json.js';
import { BundleError, PathTraversalError } from './errors.js';

/** The placeholder Speckify stamps into every bundle before a real version is known. */
export const PLACEHOLDER_VERSION = '0.0.0';

interface OpenApiInfo {
  version?: unknown;
  [key: string]: unknown;
}

interface OpenApiDocument {
  info?: OpenApiInfo;
  [key: string]: unknown;
}

function isOpenApiDocument(value: unknown): value is OpenApiDocument {
  return typeof value === 'object' && value !== null;
}

/**
 * Strips `$id` and `$schema` from every object in the bundled tree, in
 * place. An external `.schema.json` file commonly declares both so it can
 * be validated standalone; once inlined they serve no purpose, and their
 * presence pushes datamodel-code-generator into treating the schema as its
 * own module (`Modular references require an output directory, not a
 * file`), forcing directory-mode output for what is otherwise a single
 * bundled document.
 */
function stripInlinedSchemaMetadata(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      stripInlinedSchemaMetadata(item);
    }
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  const record = value as { $id?: unknown; $schema?: unknown } & Record<string, unknown>;
  delete record.$id;
  delete record.$schema;
  for (const key of Object.keys(record)) {
    stripInlinedSchemaMetadata(record[key]);
  }
}

/**
 * Resolves every file a spec's `$ref`s reach and throws {@link PathTraversalError}
 * if any of them fall outside `root`. Symlinks are resolved first, so a link
 * inside the root that points outside it is caught too.
 */
async function assertRefsWithinRoot(specPath: string, root: string): Promise<void> {
  const refs = await $RefParser.resolve(specPath);
  const realRoot = await realpath(root);
  const filePaths = refs.paths('file');

  for (const filePath of filePaths) {
    const realFilePath = await realpath(filePath);
    const isWithinRoot = realFilePath === realRoot || realFilePath.startsWith(`${realRoot}${sep}`);
    if (!isWithinRoot) {
      throw new PathTraversalError(filePath, realRoot);
    }
  }
}

export interface BundleSpecOptions {
  /** The directory no `$ref` may resolve outside of. */
  repoRoot: string;
}

/**
 * Bundles the OpenAPI document at `specPath`: inlines every external `$ref`,
 * stamps {@link PLACEHOLDER_VERSION} into `info.version` (the real version is
 * applied after the semver bump is computed, never authored by hand), and
 * serialises the result as canonical, key-sorted JSON.
 *
 * @throws {PathTraversalError} if a `$ref` resolves outside `options.repoRoot`.
 * @throws {BundleError} if the document cannot be parsed or bundled, or its
 * bundled form is not an OpenAPI document (an object with an `info` section).
 */
export async function bundleSpec(specPath: string, options: BundleSpecOptions): Promise<string> {
  const repoRoot = isAbsolute(options.repoRoot)
    ? options.repoRoot
    : resolve(process.cwd(), options.repoRoot);

  await assertRefsWithinRoot(specPath, repoRoot);

  let bundled: unknown;
  try {
    bundled = await $RefParser.bundle(specPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BundleError(`could not bundle "${specPath}": ${reason}`);
  }

  if (!isOpenApiDocument(bundled) || bundled.info === undefined) {
    throw new BundleError(`"${specPath}" does not bundle to a document with an "info" section`);
  }

  bundled.info.version = PLACEHOLDER_VERSION;
  stripInlinedSchemaMetadata(bundled);

  return toCanonicalJson(bundled);
}

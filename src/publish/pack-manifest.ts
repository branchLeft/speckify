import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { PublishError } from './errors.js';

/** The file `speckify publish --pack-only` writes into the pack directory. */
export const PACK_MANIFEST_FILENAME = 'speckify-pack.json';

const packageNameAndVersion = {
  label: z.string().min(1),
  packageName: z.string().min(1),
  version: z.string().min(1),
};

const npmEntrySchema = z.object({
  kind: z.literal('npm'),
  ...packageNameAndVersion,
  // A file name, never a path: the tarball sits directly in the pack directory.
  tarball: z.string().regex(/^[^/\\]+\.tgz$/, 'must be a plain file name ending in .tgz'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters'),
});

const pypiEntrySchema = z.object({
  kind: z.literal('pypi'),
  ...packageNameAndVersion,
  distDir: z.string().min(1),
});

const contractEntrySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  /** The changelog the release is created with. */
  changelog: z.string(),
  /** The bundled spec this run built, which the idempotency check compares the registry's against. */
  bundledSpec: z.string(),
  targets: z.array(z.discriminatedUnion('kind', [npmEntrySchema, pypiEntrySchema])),
});

/**
 * What a `--pack-only` run leaves for the `--from-pack` run that follows it:
 * for each contract, what was built, and for each npm package the tarball
 * and its digest. The tarballs are what gets attested and then published.
 */
export const packManifestSchema = z.object({
  schemaVersion: z.literal(1),
  contracts: z.array(contractEntrySchema),
});

export type PackManifest = z.infer<typeof packManifestSchema>;
export type PackManifestContract = z.infer<typeof contractEntrySchema>;
export type PackManifestNpmEntry = z.infer<typeof npmEntrySchema>;
export type PackManifestPypiEntry = z.infer<typeof pypiEntrySchema>;

/** Writes the manifest into `packDir` (created if missing) and returns its path. */
export async function writePackManifest(packDir: string, manifest: PackManifest): Promise<string> {
  await mkdir(packDir, { recursive: true });
  const file = path.join(packDir, PACK_MANIFEST_FILENAME);
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
  return file;
}

/**
 * Reads and validates the manifest in `packDir`.
 *
 * @throws {PublishError} if it is missing, not JSON, or not a manifest this
 * version of Speckify wrote.
 */
export async function readPackManifest(packDir: string): Promise<PackManifest> {
  const file = path.join(packDir, PACK_MANIFEST_FILENAME);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PublishError(`could not read the pack manifest ${file}: ${reason}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PublishError(`the pack manifest ${file} is not valid JSON`);
  }

  const parsed = packManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new PublishError(`the pack manifest ${file} is invalid: ${issues}`);
  }
  return parsed.data;
}

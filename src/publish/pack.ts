import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { PublishError } from './errors.js';
import { defaultProcessRunner } from './process-runner.js';
import type { ProcessRunner } from './types.js';

/** A tarball `npm pack` wrote: its file name, where it is, and its sha-256 digest. */
export interface PackedTarball {
  fileName: string;
  path: string;
  /** Lowercase hex sha-256 of the file's bytes. */
  sha256: string;
}

export interface PackNpmOptions {
  packageDir: string;
  /** The directory the tarball is written to. */
  packDir: string;
  runProcess?: ProcessRunner | undefined;
}

/** The lowercase hex sha-256 of a file's bytes. */
export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** What `npm pack --json` prints: a list holding one entry per package packed. */
const packOutputSchema = z.tuple([
  z.object({
    // A file name, never a path: the tarball must land inside the pack directory.
    filename: z
      .string()
      .regex(/^[^/\\]+\.tgz$/, 'must be a plain file name ending in .tgz')
      .refine((name) => name !== '.tgz' && !name.startsWith('..'), 'must name a file'),
  }),
]);

/**
 * Packs a generated npm package into a tarball with `npm pack`, exactly the
 * bytes `npm publish` would upload, so they can be attested and then
 * published unchanged.
 *
 * @throws {PublishError} if `npm pack` fails, prints something other than one
 * plain `.tgz` file name, or names a file it did not write.
 */
export async function packNpm(options: PackNpmOptions): Promise<PackedTarball> {
  const runProcess = options.runProcess ?? defaultProcessRunner;
  // npm writes the tarball but will not create the directory it goes in.
  await mkdir(options.packDir, { recursive: true });
  let stdout: string;
  try {
    ({ stdout } = await runProcess(
      'npm',
      ['pack', '--pack-destination', options.packDir, '--json'],
      {
        cwd: options.packageDir,
      },
    ));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PublishError(`npm pack failed in ${options.packageDir}: ${reason}`);
  }

  let output: unknown;
  try {
    output = JSON.parse(stdout);
  } catch {
    throw new PublishError(`npm pack in ${options.packageDir} did not print JSON: ${stdout}`);
  }
  const parsed = packOutputSchema.safeParse(output);
  if (!parsed.success) {
    throw new PublishError(
      `npm pack in ${options.packageDir} did not name exactly one tarball: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }

  const fileName = parsed.data[0].filename;
  const tarballPath = path.join(options.packDir, fileName);
  try {
    return { fileName, path: tarballPath, sha256: await sha256OfFile(tarballPath) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PublishError(`npm pack named ${tarballPath} but it could not be read: ${reason}`);
  }
}

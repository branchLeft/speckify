import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { PublishError } from './errors.js';
import { defaultProcessRunner } from './process-runner.js';
import type { ProcessRunner } from './types.js';

export interface PublishPypiOptions {
  /** The directory holding the built wheel and sdist, e.g. `dist/`. */
  distDir: string;
  packageName: string;
  runProcess?: ProcessRunner | undefined;
  /** Defaults to `uv` on PATH. */
  uvPath?: string | undefined;
}

/**
 * Publishes a generated Python package via `uv publish --trusted-publishing
 * always`: PyPI trusted publishing exchanges the workflow's OIDC token for a
 * short-lived upload token, so no PyPI credential is ever stored.
 *
 * @throws {PublishError} if `distDir` has no distribution files, or `uv
 * publish` fails.
 */
export async function publishPypi(options: PublishPypiOptions): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(options.distDir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PublishError(`could not read dist directory "${options.distDir}": ${reason}`);
  }

  const distFiles = entries
    .filter((entry) => entry.endsWith('.whl') || entry.endsWith('.tar.gz'))
    .map((entry) => join(options.distDir, entry));

  if (distFiles.length === 0) {
    throw new PublishError(
      `no wheel or sdist found in "${options.distDir}" for "${options.packageName}"`,
    );
  }

  const runProcess = options.runProcess ?? defaultProcessRunner;
  try {
    await runProcess(options.uvPath ?? 'uv', [
      'publish',
      '--trusted-publishing',
      'always',
      ...distFiles,
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PublishError(`uv publish failed for "${options.packageName}": ${reason}`);
  }
}

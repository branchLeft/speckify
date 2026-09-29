import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { BuildError } from './errors.js';
import { resolveUv } from './uv.js';
import type { BuiltArtifact } from './types.js';

export interface RunUvBuildOptions {
  /** The generated project directory (containing its own `pyproject.toml`). */
  projectDir: string;
  /** Where `uv build` writes the wheel and sdist. Defaults to `<projectDir>/dist`. */
  outputDir?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
  /** Skips PATH resolution entirely; tests use this to avoid depending on a real `uv` binary. */
  uvPath?: string;
}

function kindOf(fileName: string): 'wheel' | 'sdist' | null {
  if (fileName.endsWith('.whl')) return 'wheel';
  if (fileName.endsWith('.tar.gz')) return 'sdist';
  return null;
}

/**
 * Runs `uv build` (not `uv run`: building a standalone project uses its own
 * `pyproject.toml`, not the toolchain's) against the generated project, and
 * returns the wheel and sdist it produced.
 *
 * Unlike the generator steps, this deliberately does not run inside the
 * pinned `python/` toolchain's environment — the generated package has its
 * own dependency set (httpx, pydantic, optionally fastapi), declared in its
 * own `pyproject.toml`, and building it must resolve exactly those, not the
 * generator toolchain's.
 *
 * @throws {BuildError} if `uv build` fails or produces neither artifact.
 */
export async function runUvBuild(options: RunUvBuildOptions): Promise<BuiltArtifact[]> {
  const uvPath = options.uvPath ?? (await resolveUv(options.env ? { env: options.env } : {}));
  const outputDir = options.outputDir ?? join(options.projectDir, 'dist');
  const spawnFn = options.spawnFn ?? spawn;

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawnFn(uvPath, ['build', '--wheel', '--sdist', '--out-dir', outputDir], {
      cwd: options.projectDir,
      env: options.env ?? process.env,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      reject(new BuildError(`could not start "uv build": ${String(error)}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new BuildError(`"uv build" failed: ${stderr.trim()}`));
        return;
      }
      resolvePromise();
    });
  });

  const entries = await readdir(outputDir).catch(() => []);
  const artifacts: BuiltArtifact[] = entries
    .map((name) => ({ name, kind: kindOf(name) }))
    .filter((entry): entry is { name: string; kind: 'wheel' | 'sdist' } => entry.kind !== null)
    .map((entry) => ({ path: join(outputDir, entry.name), kind: entry.kind }));

  const hasWheel = artifacts.some((a) => a.kind === 'wheel');
  const hasSdist = artifacts.some((a) => a.kind === 'sdist');
  if (!hasWheel || !hasSdist) {
    throw new BuildError(
      `"uv build" did not produce both a wheel and an sdist in ${outputDir} (found: ${artifacts.map((a) => a.kind).join(', ') || 'nothing'})`,
    );
  }

  return artifacts;
}

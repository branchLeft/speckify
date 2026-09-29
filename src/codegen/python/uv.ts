import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { access, constants } from 'node:fs/promises';

import { SubprocessError, UvNotFoundError } from './errors.js';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Injected in tests to avoid depending on the real PATH or spawning real processes. */
export interface UvRunnerDeps {
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
  /** Skips PATH resolution entirely; tests use this to avoid depending on a real `uv` binary. */
  uvPath?: string;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves `uv` from `PATH`, the way a shell would, rather than assuming a
 * fixed install location — the environment names `/opt/homebrew/bin/uv` but
 * another machine's `uv` is just as valid.
 *
 * @throws {UvNotFoundError} if no `PATH` entry has an executable `uv`.
 */
export async function resolveUv(deps: UvRunnerDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const pathValue = env.PATH ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') {
      continue;
    }
    const candidate = join(dir, 'uv');
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  throw new UvNotFoundError();
}

/**
 * Runs `uv run --frozen <args>` inside `cwd` (the `python/` toolchain
 * directory), rejecting with {@link SubprocessError} on a non-zero exit.
 */
export async function runUv(
  args: readonly string[],
  cwd: string,
  deps: UvRunnerDeps = {},
): Promise<RunResult> {
  const uvPath = deps.uvPath ?? (await resolveUv(deps));
  const spawnFn = deps.spawnFn ?? spawn;
  const fullArgs = ['run', '--frozen', ...args];

  return new Promise((resolvePromise, reject) => {
    const child = spawnFn(uvPath, fullArgs, { cwd, env: deps.env ?? process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      reject(new SubprocessError(`uv ${fullArgs.join(' ')}`, null, String(error)));
    });
    child.on('close', (exitCode) => {
      resolvePromise({ stdout, stderr, exitCode });
    });
  });
}

/**
 * Like {@link runUv} but throws {@link SubprocessError} on a non-zero exit,
 * for callers with no reason to inspect a failing exit code themselves.
 */
export async function runUvOrThrow(
  args: readonly string[],
  cwd: string,
  deps: UvRunnerDeps = {},
): Promise<RunResult> {
  const result = await runUv(args, cwd, deps);
  if (result.exitCode !== 0) {
    throw new SubprocessError(`uv run --frozen ${args.join(' ')}`, result.exitCode, result.stderr);
  }
  return result;
}

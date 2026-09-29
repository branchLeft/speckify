import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { OasdiffError } from './errors.js';
import { oasdiffChangeSchema, type OasdiffChange } from './types.js';

const execFileAsync = promisify(execFile);

/** The subset of `execFile`'s behaviour the runner depends on, so tests can inject a fake. */
export type ProcessRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

async function defaultProcessRunner(
  command: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(command, args as string[], { maxBuffer: 1024 * 1024 * 64 });
  } catch (error) {
    // oasdiff's changelog command exits non-zero when it finds changes, which
    // is expected, not a failure; its stdout still carries the JSON we want.
    // A numeric `code` means the process ran and exited with that status; a
    // spawn failure (e.g. ENOENT) carries a string code and no real output,
    // and must still be treated as a failure.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof (error as { code: unknown }).code === 'number' &&
      'stdout' in error &&
      typeof (error as { stdout: unknown }).stdout === 'string'
    ) {
      return {
        stdout: (error as { stdout: string }).stdout,
        stderr: 'stderr' in error ? String((error as { stderr: unknown }).stderr) : '',
      };
    }
    throw error;
  }
}

export interface RunOasdiffOptions {
  oasdiffPath: string;
  baseSpecPath: string;
  revisionSpecPath: string;
  runProcess?: ProcessRunner | undefined;
}

/**
 * Runs `oasdiff changelog --format json` between two specs and parses its
 * output into typed {@link OasdiffChange}s.
 *
 * @throws {OasdiffError} if the process cannot be run, or its stdout is not
 * valid JSON matching oasdiff's changelog shape.
 */
export async function runOasdiffChangelog(options: RunOasdiffOptions): Promise<OasdiffChange[]> {
  const runProcess = options.runProcess ?? defaultProcessRunner;

  let stdout: string;
  try {
    const result = await runProcess(options.oasdiffPath, [
      'changelog',
      options.baseSpecPath,
      options.revisionSpecPath,
      '--format',
      'json',
      // oasdiff compares allOf branches one at a time unless told otherwise,
      // which understates severity: a breaking change (e.g. nullable added
      // to a required field) inside one branch reports as a WARN instead of
      // an ERR, because another branch might in principle still guarantee
      // it — under-bumping the resulting semver. Flattening first compares
      // what the branches describe together, which is what a client
      // actually receives.
      '--flatten-allof',
    ]);
    stdout = result.stdout;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OasdiffError(`oasdiff failed to run: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() === '' ? '[]' : stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OasdiffError(`oasdiff produced output that is not valid JSON: ${reason}`);
  }

  const result = oasdiffChangeSchema.array().safeParse(parsed);
  if (!result.success) {
    throw new OasdiffError(
      `oasdiff output did not match the expected changelog shape: ${result.error.message}`,
    );
  }

  return result.data;
}

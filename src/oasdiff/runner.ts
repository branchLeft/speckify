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
  // Confirmed against the real oasdiff 1.32.1 binary: `changelog` exits 0
  // whether or not it found changes, and only exits non-zero on a genuine
  // failure (e.g. a dangling $ref it cannot resolve), with empty stdout and
  // the reason on stderr. So exit code 0 is the only success signal; any
  // other exit -- however it happened to fill stdout -- must abort the plan
  // rather than be read as "no changes". execFile's own error already
  // carries stderr in its message, so there is nothing to recover here.
  return execFileAsync(command, args as string[], { maxBuffer: 1024 * 1024 * 64 });
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

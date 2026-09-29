import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ProcessRunner } from './types.js';

const execFileAsync = promisify(execFile);

/** Runs a real subprocess, rejecting on a non-zero exit — publishing has no "expected failure" case. */
export const defaultProcessRunner: ProcessRunner = async (command, args, options) => {
  return execFileAsync(command, args as string[], {
    cwd: options?.cwd,
    env: options?.env as NodeJS.ProcessEnv | undefined,
    maxBuffer: 1024 * 1024 * 64,
  });
};

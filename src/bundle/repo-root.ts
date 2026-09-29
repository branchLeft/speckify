import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The subset of `execFile`'s behaviour this needs, so tests can inject a fake. */
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Resolves the containment root every bundled spec's `$ref`s must stay
 * inside (S7): the repository root, via `git rev-parse --show-toplevel`
 * run from `configDir`, falling back to `configDir` itself when it is not
 * inside a git repository (or `git` is unavailable).
 *
 * A config-dir-only root (the previous behaviour) let a `$ref` escape into
 * a sibling package elsewhere in the same repo -- a legitimate, common
 * layout for a shared schema -- and still be refused as "path traversal",
 * while doing nothing to stop a `$ref` that escapes the actual repo
 * entirely once it happened to stay under some other ancestor directory.
 * The repository root is Speckify's real trust boundary: everything in it
 * is content the repo's own reviewers control.
 */
export async function resolveRepoRoot(
  configDir: string,
  runProcess: ProcessRunner = execFileAsync,
): Promise<string> {
  try {
    const { stdout } = await runProcess('git', ['rev-parse', '--show-toplevel'], {
      cwd: configDir,
    });
    const trimmed = stdout.trim();
    return trimmed === '' ? configDir : trimmed;
  } catch {
    return configDir;
  }
}

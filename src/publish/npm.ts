import { expectedNpmScope } from '../config/index.js';
import { PublishError } from './errors.js';
import { defaultProcessRunner } from './process-runner.js';
import type { ProcessRunner } from './types.js';

export interface PublishNpmOptions {
  packageDir: string;
  packageName: string;
  /** The GitHub Packages (or other npm-compatible) registry to publish to. */
  registryUrl: string;
  /** Bearer token, set as `NODE_AUTH_TOKEN` for the `npm publish` subprocess. */
  token: string;
  /** The configured `publish.githubPackages.owner` — re-checked here as well as in config validation. */
  owner: string;
  runProcess?: ProcessRunner | undefined;
}

/**
 * Publishes a generated npm package via `npm publish`, run as a subprocess.
 * Re-validates the package scope against `owner` even though config loading
 * already rejects a mismatch — see `docs/configuration.md` for why the
 * generated `package.json` is a second, independently-produced value worth
 * checking again here.
 *
 * @throws {PublishError} if the scope does not match, or `npm publish` fails.
 */
export async function publishNpm(options: PublishNpmOptions): Promise<void> {
  const scope = expectedNpmScope(options.owner);
  if (!options.packageName.startsWith(scope)) {
    throw new PublishError(
      `refusing to publish "${options.packageName}": its scope does not match publish.githubPackages.owner ("${options.owner}", expected scope "${scope}")`,
    );
  }

  const runProcess = options.runProcess ?? defaultProcessRunner;
  try {
    await runProcess('npm', ['publish', '--registry', options.registryUrl], {
      cwd: options.packageDir,
      env: { ...process.env, NODE_AUTH_TOKEN: options.token },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PublishError(
      `npm publish failed for "${options.packageName}" in ${options.packageDir}: ${reason}`,
    );
  }
}

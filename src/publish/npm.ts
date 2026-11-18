import path from 'node:path';

import { expectedNpmScope } from '../config/index.js';
import { PublishError } from './errors.js';
import { defaultProcessRunner } from './process-runner.js';
import type { ProcessRunner } from './types.js';

export interface PublishNpmOptions {
  packageDir: string;
  /** A tarball `npm pack` already wrote (see `packNpm`); published as it is instead of packing `packageDir` again. */
  tarball?: string | undefined;
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
 * Refuses a package whose scope is not the configured owner's: GitHub
 * Packages publishes a scoped package only under the owner it is scoped to.
 *
 * @throws {PublishError} if the scope does not match.
 */
export function assertPackageScope(packageName: string, owner: string): void {
  const scope = expectedNpmScope(owner);
  if (!packageName.startsWith(scope)) {
    throw new PublishError(
      `refusing to publish "${packageName}": its scope does not match publish.githubPackages.owner ("${owner}", expected scope "${scope}")`,
    );
  }
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
  assertPackageScope(options.packageName, options.owner);

  const runProcess = options.runProcess ?? defaultProcessRunner;
  try {
    // A packed tarball is published as it is: npm uploads the file's own
    // bytes, which are the bytes that were attested.
    const args =
      options.tarball === undefined
        ? ['publish', '--registry', options.registryUrl]
        : ['publish', options.tarball, '--registry', options.registryUrl];
    await runProcess('npm', args, {
      cwd: options.tarball === undefined ? options.packageDir : path.dirname(options.tarball),
      env: { ...process.env, NODE_AUTH_TOKEN: options.token },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PublishError(
      `npm publish failed for "${options.packageName}" in ${options.packageDir}: ${reason}`,
    );
  }
}

import type { RegistryRecord } from '../record/index.js';
import { publishNpm, type PublishNpmOptions } from './npm.js';
import { publishPypi, type PublishPypiOptions } from './pypi.js';
import type { PublishTarget, TargetOutcome } from './types.js';

export interface PublishContractOptions {
  targets: readonly PublishTarget[];
  /** Registry readers, keyed the same way `target.kind` is, used for the idempotency check. */
  registries: { npm?: RegistryRecord | undefined; pypi?: RegistryRecord | undefined };
  /** Overrides for testing; production callers only need to fill in credentials via these. */
  publishNpmFn?: ((options: PublishNpmOptions) => Promise<void>) | undefined;
  publishPypiFn?: ((options: PublishPypiOptions) => Promise<void>) | undefined;
  /** Shared npm publish inputs not carried on the target itself. */
  npmRegistryUrl: string;
  npmToken: string;
  npmOwner: string;
}

async function isAlreadyPublished(
  registry: RegistryRecord | undefined,
  packageName: string,
  version: string,
): Promise<boolean> {
  if (registry === undefined) {
    return false;
  }
  const entry = await registry.latest(packageName);
  return entry?.version === version;
}

/**
 * Publishes every target for a contract, skipping any whose version the
 * registry already reports (idempotent re-runs) and never letting one
 * target's failure stop the others — each target gets its own outcome, and
 * the caller decides how to report and exit.
 */
export async function publishContract(options: PublishContractOptions): Promise<TargetOutcome[]> {
  const publishNpmFn = options.publishNpmFn ?? publishNpm;
  const publishPypiFn = options.publishPypiFn ?? publishPypi;

  const outcomes: TargetOutcome[] = [];

  for (const target of options.targets) {
    const registry = target.kind === 'npm' ? options.registries.npm : options.registries.pypi;
    try {
      if (await isAlreadyPublished(registry, target.packageName, target.version)) {
        outcomes.push({ target, status: 'already-published' });
        continue;
      }

      if (target.kind === 'npm') {
        await publishNpmFn({
          packageDir: target.packageDir,
          packageName: target.packageName,
          registryUrl: options.npmRegistryUrl,
          token: options.npmToken,
          owner: options.npmOwner,
        });
      } else {
        await publishPypiFn({ distDir: target.distDir, packageName: target.packageName });
      }
      outcomes.push({ target, status: 'published' });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outcomes.push({ target, status: 'failed', error: reason });
    }
  }

  return outcomes;
}

/** True if any target in the report failed — the CLI's exit-code signal. */
export function hasFailures(outcomes: readonly TargetOutcome[]): boolean {
  return outcomes.some((outcome) => outcome.status === 'failed');
}

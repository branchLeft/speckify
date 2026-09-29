import { toCanonicalJson } from '../bundle/canonical-json.js';
import type { RegistryRecord } from '../record/index.js';
import { publishNpm, type PublishNpmOptions } from './npm.js';
import { publishPypi, type PublishPypiOptions } from './pypi.js';
import type { PublishTarget, TargetOutcome } from './types.js';

export interface PublishContractOptions {
  targets: readonly PublishTarget[];
  /** Registry readers, keyed the same way `target.kind` is, used for the idempotency check. */
  registries: { npm?: RegistryRecord | undefined; pypi?: RegistryRecord | undefined };
  /**
   * The spec Speckify just bundled for this publish run (the same one every
   * target in this contract carries), used to tell a genuine re-run of an
   * already-published version apart from a concurrent publish that raced
   * this one to the same version with a different spec.
   */
  builtBundledSpec: string;
  /** Overrides for testing; production callers only need to fill in credentials via these. */
  publishNpmFn?: ((options: PublishNpmOptions) => Promise<void>) | undefined;
  publishPypiFn?: ((options: PublishPypiOptions) => Promise<void>) | undefined;
  /** Shared npm publish inputs not carried on the target itself. */
  npmRegistryUrl: string;
  npmToken: string;
  npmOwner: string;
}

/**
 * Normalises JSON text for comparison, independent of key order or
 * incidental whitespace. Both sides are already expected to be
 * {@link toCanonicalJson} output, but re-normalising here makes the
 * comparison correct regardless of that -- and cheap, since both documents
 * are already parsed once per idempotency check.
 */
function normalizedJson(json: string): string {
  return toCanonicalJson(JSON.parse(json));
}

type PublishedCheck = 'not-published' | 'already-published';

/**
 * Tells a target that genuinely needs publishing apart from one the
 * registry already has at the target version. A version match with an
 * identical (normalised) spec is a safe, idempotent re-run and is skipped;
 * a version match with a *different* spec means a concurrent publish raced
 * this one to that version number, and is a loud failure rather than a
 * silent skip or a silent overwrite -- the registry state and this run's
 * plan have already diverged.
 *
 * @throws {Error} when the registry has this version already, published
 * with a different spec.
 */
async function checkAlreadyPublished(
  registry: RegistryRecord | undefined,
  packageName: string,
  version: string,
  builtBundledSpec: string,
): Promise<PublishedCheck> {
  if (registry === undefined) {
    return 'not-published';
  }
  const entry = await registry.latest(packageName);
  if (entry?.version !== version) {
    return 'not-published';
  }
  if (normalizedJson(entry.bundledSpec) === normalizedJson(builtBundledSpec)) {
    return 'already-published';
  }
  throw new Error(
    `version ${version} was published with a different spec — a concurrent publish raced this one; rerun to compute a new version`,
  );
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
      const check = await checkAlreadyPublished(
        registry,
        target.packageName,
        target.version,
        options.builtBundledSpec,
      );
      if (check === 'already-published') {
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

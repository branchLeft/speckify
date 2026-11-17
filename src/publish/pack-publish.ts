import path from 'node:path';

import type { RegistryRecord } from '../record/index.js';
import { assertDigestsAttested, attestedSha256s } from './attestation.js';
import { checkAlreadyPublished, publishContract } from './contract.js';
import { PublishError } from './errors.js';
import { assertPackageScope, type PublishNpmOptions } from './npm.js';
import { packNpm, sha256OfFile, type PackNpmOptions, type PackedTarball } from './pack.js';
import type { PackManifest, PackManifestContract } from './pack-manifest.js';
import type { PublishPypiOptions } from './pypi.js';
import type { PublishTarget, TargetOutcome } from './types.js';

interface Registries {
  npm?: RegistryRecord | undefined;
  pypi?: RegistryRecord | undefined;
}

export interface PackContractOptions {
  contract: string;
  version: string;
  changelog: string;
  /** The spec this run bundled; the registry's copy is compared against it. */
  bundledSpec: string;
  targets: readonly PublishTarget[];
  /** The directory tarballs are written to. */
  packDir: string;
  registries: Registries;
  /** The configured `publish.githubPackages.owner`: an npm package outside its scope is not packed. */
  npmOwner: string;
  packNpmFn?: ((options: PackNpmOptions) => Promise<PackedTarball>) | undefined;
}

export interface PackContractResult {
  /** What the later `--from-pack` run needs for this contract. Holds only the targets still to publish. */
  contract: PackManifestContract;
  /** `published` here means packed: nothing reached a registry. */
  outcomes: TargetOutcome[];
}

/**
 * Packs every npm target of a contract that its registry does not already
 * hold, and records the Python dists still to publish, without publishing
 * anything. A version already published with the same spec is skipped (the
 * same idempotency as publishing); one published with a different spec, or
 * any other failure, is that target's own failed outcome and stops no other.
 */
export async function packContract(options: PackContractOptions): Promise<PackContractResult> {
  const packNpmFn = options.packNpmFn ?? packNpm;
  const recorded: PackManifestContract['targets'] = [];
  const outcomes: TargetOutcome[] = [];

  for (const target of options.targets) {
    try {
      const check = await checkAlreadyPublished(
        target.kind === 'npm' ? options.registries.npm : options.registries.pypi,
        target.packageName,
        target.version,
        options.bundledSpec,
      );
      if (check === 'already-published') {
        outcomes.push({ target, status: 'already-published' });
        continue;
      }

      if (target.kind === 'npm') {
        assertPackageScope(target.packageName, options.npmOwner);
        const packed = await packNpmFn({
          packageDir: target.packageDir,
          packDir: options.packDir,
        });
        recorded.push({
          kind: 'npm',
          label: target.label,
          packageName: target.packageName,
          version: target.version,
          tarball: packed.fileName,
          sha256: packed.sha256,
        });
      } else {
        recorded.push({
          kind: 'pypi',
          label: target.label,
          packageName: target.packageName,
          version: target.version,
          distDir: target.distDir,
        });
      }
      outcomes.push({ target, status: 'published' });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outcomes.push({ target, status: 'failed', error: reason });
    }
  }

  return {
    contract: {
      name: options.contract,
      version: options.version,
      changelog: options.changelog,
      bundledSpec: options.bundledSpec,
      targets: recorded,
    },
    outcomes,
  };
}

export interface PublishFromPackOptions {
  packDir: string;
  manifest: PackManifest;
  registries: Registries;
  npmRegistryUrl: string;
  npmToken: string;
  npmOwner: string;
  /**
   * The text of each attestation file for the packed tarballs. When any are
   * given, every tarball's digest must be among their subjects, or nothing
   * is published.
   */
  attestationBundles?: readonly string[] | undefined;
  /**
   * Refuse to publish any npm tarball unless attestation files were given
   * (and so checked). Without it, publishing with no attestation files is
   * allowed, for a caller that has chosen not to attest.
   */
  requireAttestation?: boolean | undefined;
  /**
   * Called for each npm tarball, after its digest is checked and before
   * anything is published, to prove who signed its attestation (see
   * `verifyTarballAttestation`). It rejects to stop the whole publish.
   */
  verifyTarball?:
    | ((tarball: { label: string; tarballPath: string; sha256: string }) => Promise<void>)
    | undefined;
  publishNpmFn?: ((options: PublishNpmOptions) => Promise<void>) | undefined;
  publishPypiFn?: ((options: PublishPypiOptions) => Promise<void>) | undefined;
}

export interface PublishFromPackResult {
  name: string;
  version: string;
  changelog: string;
  bundledSpec: string;
  outcomes: TargetOutcome[];
}

/**
 * Checks every packed tarball is still, byte for byte, what was packed, by
 * the digest the manifest recorded.
 *
 * @throws {PublishError} naming the first tarball that is missing or differs.
 */
async function assertTarballsUnchanged(
  packDir: string,
  tarballs: readonly { label: string; tarball: string; sha256: string }[],
): Promise<void> {
  for (const entry of tarballs) {
    let found: string;
    try {
      found = await sha256OfFile(path.join(packDir, entry.tarball));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new PublishError(`${entry.label}: could not read ${entry.tarball}: ${reason}`);
    }
    if (found !== entry.sha256) {
      throw new PublishError(
        `${entry.label}: ${entry.tarball} changed since it was packed (packed sha256:${entry.sha256}, found sha256:${found})`,
      );
    }
  }
}

/**
 * Publishes what a `--pack-only` run left in `packDir`: each npm package from
 * its packed tarball, the very file that was attested, and each Python dist
 * from where it was built.
 *
 * Before anything is published, every tarball is re-hashed against the
 * manifest, and, when attestation files are given, against the subjects they
 * cover, so the bytes the registry receives are the bytes that were signed.
 * A mismatch publishes nothing at all.
 *
 * @throws {PublishError} when a tarball is missing, changed, or not attested,
 * or an attestation file is unreadable.
 */
export async function publishFromPack(
  options: PublishFromPackOptions,
): Promise<PublishFromPackResult[]> {
  const tarballs = options.manifest.contracts.flatMap((contract) =>
    contract.targets.flatMap((target) => (target.kind === 'npm' ? [target] : [])),
  );

  await assertTarballsUnchanged(options.packDir, tarballs);

  const bundles = options.attestationBundles ?? [];
  if (bundles.length > 0) {
    const attested = new Set(bundles.flatMap((text) => [...attestedSha256s(text)]));
    assertDigestsAttested(tarballs, attested);
  } else if (options.requireAttestation === true && tarballs.length > 0) {
    throw new PublishError(
      `refusing to publish ${tarballs.map((tarball) => tarball.label).join(', ')}: an attestation is required and no attestation was given`,
    );
  }

  for (const entry of tarballs) {
    await options.verifyTarball?.({
      label: entry.label,
      tarballPath: path.join(options.packDir, entry.tarball),
      sha256: entry.sha256,
    });
  }

  const results: PublishFromPackResult[] = [];
  for (const contract of options.manifest.contracts) {
    const targets: PublishTarget[] = contract.targets.map((target) =>
      target.kind === 'npm'
        ? {
            kind: 'npm',
            label: target.label,
            packageDir: options.packDir,
            tarball: path.join(options.packDir, target.tarball),
            packageName: target.packageName,
            version: target.version,
          }
        : {
            kind: 'pypi',
            label: target.label,
            distDir: target.distDir,
            packageName: target.packageName,
            version: target.version,
          },
    );

    const outcomes = await publishContract({
      targets,
      registries: options.registries,
      builtBundledSpec: contract.bundledSpec,
      publishNpmFn: options.publishNpmFn,
      publishPypiFn: options.publishPypiFn,
      npmRegistryUrl: options.npmRegistryUrl,
      npmToken: options.npmToken,
      npmOwner: options.npmOwner,
    });
    results.push({
      name: contract.name,
      version: contract.version,
      changelog: contract.changelog,
      bundledSpec: contract.bundledSpec,
      outcomes,
    });
  }
  return results;
}

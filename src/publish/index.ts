export { hasFailures, publishContract, type PublishContractOptions } from './contract.js';
export { assertDigestsAttested, attestedSha256s } from './attestation.js';
export { PublishError } from './errors.js';
export {
  PACK_MANIFEST_FILENAME,
  readPackManifest,
  writePackManifest,
  type PackManifest,
  type PackManifestContract,
} from './pack-manifest.js';
export {
  packContract,
  publishFromPack,
  type PackContractOptions,
  type PackContractResult,
  type PublishFromPackOptions,
  type PublishFromPackResult,
} from './pack-publish.js';
export { packNpm, sha256OfFile, type PackedTarball } from './pack.js';
export {
  ATTESTATION_OIDC_ISSUER,
  SLSA_PROVENANCE_PREDICATE,
  verifyTarballAttestation,
  type AttestationIdentity,
} from './verify-attestation.js';
export { publishNpm, type PublishNpmOptions } from './npm.js';
export { publishPypi, type PublishPypiOptions } from './pypi.js';
export type {
  NpmPublishTarget,
  ProcessRunner,
  PublishTarget,
  PyPiPublishTarget,
  TargetOutcome,
  TargetOutcomeStatus,
} from './types.js';

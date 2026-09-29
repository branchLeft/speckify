export { applyBump, FIRST_PUBLISHED_VERSION, maxBump } from './bump.js';
export {
  loadClassificationMap,
  loadOasdiffCheckIds,
  type LoadClassificationMapOptions,
} from './classification-map.js';
export { classify } from './classify.js';
export {
  findUncoveredEdits,
  loadOasdiffCoverage,
  type LoadOasdiffCoverageOptions,
  type OasdiffCoverage,
  type UncoveredEdit,
} from './location-coverage.js';
export { diffDocuments, prepareDocument, type Edit } from './structural-diff.js';
export { VersionError } from './errors.js';
export {
  loadToolchainImpact,
  toolchainImpact,
  TOOLCHAIN_IMPACT_FILENAME,
} from './toolchain-impact.js';
export type {
  Bump,
  ClassificationMap,
  ClassificationRule,
  ClassifyResult,
  LocationClaimsFile,
  SilentClaimsFile,
  OasdiffCheck,
  ToolchainImpactEntry,
} from './types.js';

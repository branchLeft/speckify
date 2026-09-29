import { z } from 'zod';

/** `none` means the change carries no version consequence at all. */
export const bumpSchema = z.enum(['major', 'minor', 'patch', 'none']);
export type Bump = z.infer<typeof bumpSchema>;

/**
 * A rule id to the bump it forces, as `classify` looks it up. A rule id
 * absent from the map is never silently ignored: `classify` treats it as
 * `major`, so an incomplete map fails loud rather than under-bumping.
 */
export type ClassificationMap = Record<string, Bump>;

/**
 * One row of the committed classification map: an oasdiff rule id judged
 * from the perspective of an existing, correctly-written client, with the
 * oasdiff-native fields (`oasdiffLevel`, `direction`, `effect`) kept
 * alongside the resulting `bump` so the judgement can be audited against
 * its source, not just trusted.
 */
export const classificationRuleSchema = z.object({
  id: z.string(),
  oasdiffLevel: z.enum(['INFO', 'WARN', 'ERR']),
  direction: z.enum(['request', 'response', 'none']),
  effect: z.enum(['none', 'widens', 'narrows', 'violation', 'unknown', 'incomparable']),
  bump: bumpSchema,
  reason: z.string(),
  source: z.string(),
});
export type ClassificationRule = z.infer<typeof classificationRuleSchema>;

/** The committed classification map file's shape: `data/oasdiff-<version>.classification.json`. */
export const classificationMapFileSchema = z.object({
  oasdiffVersion: z.string(),
  perspective: z.string(),
  rules: z.array(classificationRuleSchema),
});
export type ClassificationMapFile = z.infer<typeof classificationMapFileSchema>;

/**
 * One entry of oasdiff's own `checks changelog --format json` output: the
 * full catalogue of rule ids that can ever appear in a changelog. Only
 * `id` is validated strictly; the rest of oasdiff's shape is carried
 * through untyped since nothing here consumes it.
 */
export const oasdiffCheckSchema = z.object({ id: z.string() }).passthrough();
export const oasdiffCheckCatalogueSchema = z.array(oasdiffCheckSchema);
export type OasdiffCheck = z.infer<typeof oasdiffCheckSchema>;

export interface ClassifyResult {
  bump: Bump;
  /** Rule ids the map had no entry for; each one was treated as `major`. */
  unknownRuleIds: string[];
}

/** One Speckify release and the bump its own toolchain changes force on every consumer. */
export const toolchainImpactEntrySchema = z.object({
  speckifyVersion: z.string(),
  impact: bumpSchema,
});
export type ToolchainImpactEntry = z.infer<typeof toolchainImpactEntrySchema>;

export const toolchainImpactFileSchema = z.array(toolchainImpactEntrySchema);

import { z } from 'zod';

/** `none` means the change carries no version consequence at all. */
export const bumpSchema = z.enum(['major', 'minor', 'patch', 'none']);
export type Bump = z.infer<typeof bumpSchema>;

/**
 * Maps an oasdiff rule id to the bump it forces. A rule id absent from the
 * map is never silently ignored: `classify` treats it as `major`, so an
 * incomplete map fails loud rather than under-bumping.
 */
export const classificationMapSchema = z.record(z.string(), bumpSchema);
export type ClassificationMap = z.infer<typeof classificationMapSchema>;

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

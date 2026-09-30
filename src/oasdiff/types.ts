import { z } from 'zod';

/**
 * One entry from `oasdiff changelog --format json`. oasdiff's own schema has
 * more fields than this; only the ones Speckify's classifier and changelog
 * rendering use are validated, and everything else is dropped rather than
 * carried around untyped.
 */
export const oasdiffChangeSchema = z.object({
  id: z.string(),
  text: z.string(),
  level: z.number(),
  operation: z.string().optional(),
  path: z.string().optional(),
});

export type OasdiffChange = z.infer<typeof oasdiffChangeSchema>;

import { createClient } from '@hey-api/openapi-ts';
import type { BundledSpec } from '../../bundle/index.js';

/**
 * Runs @hey-api/openapi-ts programmatically against an already-bundled spec,
 * producing types.gen.ts, zod.gen.ts, sdk.gen.ts and the fetch client
 * runtime in `outputDir`. The spec is passed as a parsed object (not a file
 * path) since Speckify already holds the bundled document in memory.
 */
export async function runHeyApi(spec: BundledSpec, outputDir: string): Promise<void> {
  await createClient({
    input: { path: spec as unknown as Record<string, unknown> },
    output: {
      path: outputDir,
      // hey-api's auto-detection of moduleResolution fails in consumer
      // installs. See heyapi.md for why this must be explicit.
      importFileExtension: '.js',
    },
    plugins: ['@hey-api/typescript', '@hey-api/sdk', '@hey-api/client-fetch', 'zod'],
  });
}

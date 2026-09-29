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
      // buildPackage() always compiles the generated package with
      // moduleResolution: NodeNext, which requires explicit extensions on
      // relative imports. Left unset, hey-api tries to auto-detect this by
      // walking up from *its own installed location* looking for a
      // tsconfig.json with `moduleResolution`/`module` set to nodenext/
      // node16 -- inside this repo's checkout that walk happens to reach
      // this repo's own tsconfig.json (nodenext) and passes by accident;
      // for any real consumer (a plain `npm install speckify`), hey-api's
      // installed location has no such tsconfig anywhere above it, the
      // auto-detection finds nothing, and the generated imports come out
      // extension-less -- which NodeNext resolution then rejects outright.
      importFileExtension: '.js',
    },
    plugins: ['@hey-api/typescript', '@hey-api/sdk', '@hey-api/client-fetch', 'zod'],
  });
}

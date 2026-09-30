import { readdir } from 'node:fs/promises';

const OPENAPI_SPEC_PATTERN = /^openapi.*\.(ya?ml|json)$/i;

/**
 * Finds candidate OpenAPI documents directly under `dir` by filename
 * convention (`openapi.yaml`, `openapi.json`, `openapi-orders.yaml`, …),
 * sorted for a stable, reproducible `speckify.yaml`.
 */
export async function detectOpenapiSpecs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && OPENAPI_SPEC_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

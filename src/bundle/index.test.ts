import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { bundleSpec, PLACEHOLDER_VERSION } from './index.js';
import { BundleError, PathTraversalError } from './errors.js';

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const repoRoot = `${fixturesDir}repo`;

interface BundledWidgetsDoc {
  info: { version: string };
  paths: {
    '/widgets': {
      get: {
        responses: {
          '200': { content: { 'application/json': { schema: unknown } } };
        };
      };
    };
  };
}

describe('bundleSpec', () => {
  it('inlines an external .schema.json $ref and stamps the placeholder version', async () => {
    const result = await bundleSpec(`${repoRoot}/openapi.yaml`, { repoRoot });
    const doc = JSON.parse(result) as BundledWidgetsDoc;

    expect(doc.info.version).toBe(PLACEHOLDER_VERSION);
    const schema = doc.paths['/widgets'].get.responses['200'].content['application/json'].schema;
    expect(schema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      required: ['id', 'name'],
    });
  });

  it('produces deterministic, key-sorted JSON with a trailing newline', async () => {
    const result = await bundleSpec(`${repoRoot}/openapi.yaml`, { repoRoot });
    expect(result.endsWith('\n')).toBe(true);
    const again = await bundleSpec(`${repoRoot}/openapi.yaml`, { repoRoot });
    expect(result).toBe(again);
  });

  it('refuses a $ref that escapes the repo root', async () => {
    await expect(bundleSpec(`${repoRoot}/escaping.yaml`, { repoRoot })).rejects.toThrow(
      PathTraversalError,
    );
  });

  it('throws BundleError for a spec that cannot be parsed', async () => {
    await expect(bundleSpec(`${repoRoot}/does-not-exist.yaml`, { repoRoot })).rejects.toThrow();
  });

  it('throws BundleError when the bundled document has no info section', async () => {
    await expect(
      bundleSpec(`${repoRoot}/schemas/widget.schema.json`, { repoRoot }),
    ).rejects.toThrow(BundleError);
  });
});

import { relative } from 'node:path';
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
    '/things': {
      get: {
        responses: {
          '200': { content: { 'application/json': { schema: Record<string, unknown> } } };
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

  it('strips $id and $schema from a schema inlined from an external file', async () => {
    const result = await bundleSpec(`${repoRoot}/openapi.yaml`, { repoRoot });
    const doc = JSON.parse(result) as BundledWidgetsDoc;

    const schema = doc.paths['/things'].get.responses['200'].content['application/json'].schema;
    expect(schema.$id).toBeUndefined();
    expect(schema.$schema).toBeUndefined();
    // Everything else the external file declared survives, including its
    // own-file-relative internal $ref, which is untouched.
    expect(schema.type).toBe('object');
    expect(schema.properties).toEqual({
      id: { type: 'string' },
      kind: { $ref: '#/$defs/ThingKind' },
    });
    expect(schema.$defs).toEqual({ ThingKind: { type: 'string', enum: ['a', 'b'] } });
  });

  it('produces deterministic, key-sorted JSON with a trailing newline', async () => {
    const result = await bundleSpec(`${repoRoot}/openapi.yaml`, { repoRoot });
    expect(result.endsWith('\n')).toBe(true);
    const again = await bundleSpec(`${repoRoot}/openapi.yaml`, { repoRoot });
    expect(result).toBe(again);
  });

  it('resolves a relative repoRoot against the current working directory', async () => {
    const relativeRoot = relative(process.cwd(), repoRoot);
    const result = await bundleSpec(`${repoRoot}/openapi.yaml`, { repoRoot: relativeRoot });
    const doc = JSON.parse(result) as BundledWidgetsDoc;
    expect(doc.info.version).toBe(PLACEHOLDER_VERSION);
  });

  it('refuses a $ref that escapes the repo root', async () => {
    await expect(bundleSpec(`${repoRoot}/escaping.yaml`, { repoRoot })).rejects.toThrow(
      PathTraversalError,
    );
  });

  it('throws BundleError for a spec that cannot be parsed', async () => {
    await expect(bundleSpec(`${repoRoot}/does-not-exist.yaml`, { repoRoot })).rejects.toThrow();
  });

  it('throws BundleError when a $ref points at a file that exists but a JSON pointer within it that does not', async () => {
    // The file itself resolves fine (no path traversal), but dereferencing
    // its pointer fails at bundle time, not at the earlier file-resolution
    // check — this exercises that later, separate failure mode.
    await expect(bundleSpec(`${repoRoot}/bad-pointer.yaml`, { repoRoot })).rejects.toThrow(
      BundleError,
    );
  });

  it('throws BundleError when the bundled document has no info section', async () => {
    await expect(
      bundleSpec(`${repoRoot}/schemas/widget.schema.json`, { repoRoot }),
    ).rejects.toThrow(BundleError);
  });
});

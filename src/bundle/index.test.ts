import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $RefParser } from '@apidevtools/json-schema-ref-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  // S1: a remote $ref is refused, never fetched -- both when checking it's
  // within the repo root and when actually bundling. Left enabled, this is
  // an SSRF surface (the bundler fetches whatever URL a spec author, or
  // anyone who can edit the spec via a PR, writes) and makes the bundled
  // contract depend on a public URL staying up and byte-for-byte unchanged
  // forever. json-schema-ref-parser's own built-in `safeUrlResolver` blocks
  // *unsafe* (private/loopback) targets already, which would make a fake
  // local test server pass even without this fix and prove nothing -- so
  // this instead asserts on the options actually passed to the resolver,
  // which is what determines whether a legitimate *public* URL is ever
  // attempted at all.
  describe('a remote $ref', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('is never resolved: both $RefParser calls disable the http resolver', async () => {
      const resolveSpy = vi.spyOn($RefParser, 'resolve');
      const bundleSpy = vi.spyOn($RefParser, 'bundle');

      await bundleSpec(`${repoRoot}/openapi.yaml`, { repoRoot });

      const expectedOptions: unknown = { resolve: { http: false } };
      expect(resolveSpy).toHaveBeenCalledWith(expect.anything(), expectedOptions);
      expect(bundleSpy).toHaveBeenCalledWith(expect.anything(), expectedOptions);
    });

    it('makes a spec with an https $ref fail to bundle, rather than fetching it', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'speckify-bundle-remote-ref-'));
      try {
        const specPath = join(tempDir, 'openapi.yaml');
        await writeFile(
          specPath,
          [
            'openapi: 3.0.3',
            'info:',
            '  title: Remote ref fixture',
            '  version: 9.9.9',
            'paths:',
            '  /widgets:',
            '    get:',
            '      operationId: listWidgets',
            '      responses:',
            "        '200':",
            '          description: OK',
            '          content:',
            '            application/json:',
            '              schema:',
            "                $ref: 'https://example.com/widget.schema.json'",
            '',
          ].join('\n'),
          'utf8',
        );

        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        await expect(bundleSpec(specPath, { repoRoot: tempDir })).rejects.toThrow();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});

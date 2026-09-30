import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { generateTypeScriptPackage } from './generate.js';
import type { BundledSpec } from '../../bundle/index.js';

const execFileAsync = promisify(execFile);
const FIXTURES_DIR = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'codegen-ts',
);

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function loadFixture(name: string): Promise<BundledSpec> {
  const text = await readFile(path.join(FIXTURES_DIR, name), 'utf8');
  return parseYaml(text) as BundledSpec;
}

async function generateFixture(name: string, packageName: string): Promise<string> {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'speckify-roundtrip-'));
  tempDirs.push(outDir);
  await generateTypeScriptPackage({
    bundledSpec: await loadFixture(name),
    packageName,
    version: '1.0.0',
    client: true,
    server: true,
    changelog: '',
    speckifyVersion: '0.1.0',
    outDir,
  });
  return outDir;
}

/**
 * Runs a Node script (as a module) against the generated package's own
 * compiled dist/server.js and returns whatever it prints as JSON. A real
 * child process, rather than Vitest's own module loader, is needed here:
 * Vite refuses to import files outside the project root (see build.test.ts).
 */
async function runAgainstServer<T>(outDir: string, script: string): Promise<T> {
  const scriptPath = path.join(outDir, 'roundtrip-script.mjs');
  await writeFile(scriptPath, script);
  const { stdout } = await execFileAsync(process.execPath, [scriptPath]);
  return JSON.parse(stdout) as T;
}

describe('generated server round-trip', () => {
  it('serves a 200/404 discriminated-union response and rejects an invalid body with 400', async () => {
    const outDir = await generateFixture(
      'multi-status.bundled.yaml',
      '@speckify-fixtures/multi-status',
    );

    const results = await runAgainstServer<{
      ok: unknown;
      missing: unknown;
      okStatus: number;
      missingStatus: number;
    }>(
      outDir,
      `
        import http from 'node:http';
        import { createServer } from '${path.join(outDir, 'dist', 'server.js')}';

        const handlers = {
          async getWidget(request) {
            if (request.path.id === 'missing') {
              return { status: 404, body: { message: 'not found' } };
            }
            return { status: 200, body: { id: request.path.id, name: 'Widget' } };
          },
        };
        const server = http.createServer(createServer(handlers));
        await new Promise((resolve) => server.listen(0, resolve));
        const port = server.address().port;

        const ok = await fetch(\`http://127.0.0.1:\${port}/widgets/1\`);
        const missing = await fetch(\`http://127.0.0.1:\${port}/widgets/missing\`);
        console.log(JSON.stringify({
          ok: await ok.json(),
          okStatus: ok.status,
          missing: await missing.json(),
          missingStatus: missing.status,
        }));
        server.close();
        `,
    );

    expect(results.okStatus).toBe(200);
    expect(results.ok).toEqual({ id: '1', name: 'Widget' });
    expect(results.missingStatus).toBe(404);
    expect(results.missing).toEqual({ message: 'not found' });
  }, 30_000);

  it('streams an octet-stream body through unbuffered and validates required headers', async () => {
    const outDir = await generateFixture(
      'f-binary-upload.bundled.yaml',
      '@speckify-fixtures/f-binary-upload-rt',
    );

    const results = await runAgainstServer<{
      okStatus: number;
      okBody: unknown;
      missingHeaderStatus: number;
    }>(
      outDir,
      `
        import http from 'node:http';
        import { createServer } from '${path.join(outDir, 'dist', 'server.js')}';

        const handlers = {
          async uploadBlob(request) {
            let bytes = 0;
            for await (const chunk of request.body) bytes += chunk.length;
            return { status: 201, body: { id: 'blob-' + bytes } };
          },
        };
        const server = http.createServer(createServer(handlers));
        await new Promise((resolve) => server.listen(0, resolve));
        const port = server.address().port;

        const ok = await fetch(\`http://127.0.0.1:\${port}/uploads\`, {
          method: 'POST',
          headers: { 'X-Signature': 'sig', 'X-Timestamp': new Date().toISOString(), 'content-type': 'application/octet-stream' },
          body: new Uint8Array([1, 2, 3]),
        });
        const missingHeader = await fetch(\`http://127.0.0.1:\${port}/uploads\`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: new Uint8Array([1]),
        });
        console.log(JSON.stringify({
          okStatus: ok.status,
          okBody: await ok.json(),
          missingHeaderStatus: missingHeader.status,
        }));
        server.close();
        `,
    );

    expect(results.okStatus).toBe(201);
    expect(results.okBody).toEqual({ id: 'blob-3' });
    expect(results.missingHeaderStatus).toBe(400);
  }, 30_000);

  // Path and query values arrive off node:http as plain strings, but
  // the generated zod schemas type them per the OpenAPI schema (z.int(),
  // z.boolean(), z.array(...)) with no coercion of their own -- so every
  // typed path/query parameter failed validation (400) before this fix,
  // and even where it happened to pass, handlers received raw strings, not
  // the parsed values their own generated types promise.
  it('coerces path/query values by schema type and passes the parsed data to handlers', async () => {
    const outDir = await generateFixture(
      'i-param-coercion.bundled.yaml',
      '@speckify-fixtures/param-coercion-rt',
    );

    const results = await runAgainstServer<{
      status: number;
      body: unknown;
      receivedPathIdType: string;
      receivedTag: unknown;
      receivedVerboseType: string;
    }>(
      outDir,
      `
        import http from 'node:http';
        import { createServer } from '${path.join(outDir, 'dist', 'server.js')}';

        let captured;
        const handlers = {
          async getThing(request) {
            captured = request;
            return {
              status: 200,
              body: { id: request.path.id, tags: request.query.tag ?? [], verbose: request.query.verbose ?? null },
            };
          },
        };
        const server = http.createServer(createServer(handlers));
        await new Promise((resolve) => server.listen(0, resolve));
        const port = server.address().port;

        const response = await fetch(
          \`http://127.0.0.1:\${port}/things/42?tag=a&tag=b&verbose=true\`,
        );
        console.log(JSON.stringify({
          status: response.status,
          body: await response.json(),
          receivedPathIdType: typeof captured.path.id,
          receivedTag: captured.query.tag,
          receivedVerboseType: typeof captured.query.verbose,
        }));
        server.close();
        `,
    );

    expect(results.status).toBe(200);
    expect(results.body).toEqual({ id: 42, tags: ['a', 'b'], verbose: true });
    expect(results.receivedPathIdType).toBe('number');
    expect(results.receivedTag).toEqual(['a', 'b']);
    expect(results.receivedVerboseType).toBe('boolean');
  }, 30_000);
});

import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { hasUv } from '../codegen/python/test-support.js';

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exampleDir = join(repoRoot, 'examples', 'pet-shelter');
const cliPath = join(repoRoot, 'dist', 'cli.js');

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

const uvAvailable = await hasUv();
const networkAvailable = await reachable('https://registry.npmjs.org');

/**
 * Runs the *built* CLI, not the TypeScript source under vitest --
 * src/e2e/pet-shelter.test.ts runs against src/ directly, so it never
 * notices when `pnpm build` fails to carry a runtime asset (a Jinja2
 * template, the raw TS server-adapter template) into dist/. server:true
 * on both languages exercises the templates only server codegen reads.
 * This contract's package names have never been published to either real
 * registry hit here, so `resolvePreviousState` naturally resolves to
 * "never published" without this test writing to either.
 */
describe.skipIf(!networkAvailable)('the built CLI (node dist/cli.js build)', () => {
  it('generates and builds server code for both languages from dist, using templates dist must carry', async () => {
    await execFileAsync('npm', ['run', 'build'], { cwd: repoRoot });

    const workDir = await mkdtemp(join(tmpdir(), 'speckify-built-cli-'));
    try {
      await cp(join(exampleDir, 'openapi.yaml'), join(workDir, 'openapi.yaml'));

      const speckifyYaml = [
        'contracts:',
        '  - name: pet-shelter-built-cli-e2e',
        '    spec: ./openapi.yaml',
        '    typescript:',
        '      package: "@speckify-built-cli-e2e/pet-shelter"',
        '      client: true',
        '      server: true',
        ...(uvAvailable
          ? [
              '    python:',
              '      package: speckify-built-cli-e2e-pet-shelter',
              '      client: true',
              '      server: true',
              '',
            ]
          : ['']),
        'publish:',
        '  githubPackages:',
        '    owner: speckify-built-cli-e2e',
        '',
      ].join('\n');
      await writeFile(join(workDir, 'speckify.yaml'), speckifyYaml, 'utf8');

      const outDir = join(workDir, 'out');
      await execFileAsync(
        process.execPath,
        [cliPath, 'build', '-c', join(workDir, 'speckify.yaml'), '-o', outDir],
        { cwd: workDir, env: { ...process.env, GITHUB_TOKEN: '' } },
      );

      // The TS server adapter is only produced by copying
      // templates/server-adapter.template.ts's raw source at runtime; tsc's
      // own build never emits that file into dist under that name.
      const serverAdapter = await readFile(
        join(outDir, 'pet-shelter-built-cli-e2e', 'typescript', 'src', 'server-adapter.ts'),
        'utf8',
      );
      expect(serverAdapter).toContain('createRequestListener');

      if (uvAvailable) {
        // The Python server submodule is rendered by render_server.py via
        // its Jinja2 templates -- none of which are .ts files tsc copies.
        const router = await readFile(
          join(
            outDir,
            'pet-shelter-built-cli-e2e',
            'python',
            'src',
            'speckify_built_cli_e2e_pet_shelter',
            'server',
            'router.py',
          ),
          'utf8',
        );
        expect(router).toContain('def create_router');
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 180_000);
});

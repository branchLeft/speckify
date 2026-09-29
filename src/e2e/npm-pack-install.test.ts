import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { hasUv } from '../codegen/python/test-support.js';

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exampleDir = join(repoRoot, 'examples', 'pet-shelter');

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
 * Proves the *published* package actually starts and runs, not just the
 * repo's own checkout. `pnpm install` in this repo hoists every
 * devDependency into `node_modules` too, so a runtime import of a package
 * only declared as a devDependency (or a symlink built from this repo's own
 * node_modules layout) passes every other test here while being unusable
 * once installed for real: a consumer's `npm install speckify` never
 * fetches devDependencies, and speckify's own working directory does not
 * exist inside their node_modules tree.
 *
 * This is slow (a real `npm pack`, a real `npm install` from the tarball,
 * and — when `uv` is on PATH — a real `speckify build` running the pinned
 * Python toolchain) and needs network; it is gated the same way
 * `built-cli.test.ts` is, so it still runs for real in CI rather than being
 * silently skipped there, while staying skippable offline.
 */
describe.skipIf(!networkAvailable)('the published npm package, installed from a tarball', () => {
  it('starts and builds both languages after a clean `npm install` of the packed tarball', async () => {
    await execFileAsync('npm', ['run', 'build'], { cwd: repoRoot });

    const packDir = await mkdtemp(join(tmpdir(), 'speckify-npm-pack-'));
    const installDir = await mkdtemp(join(tmpdir(), 'speckify-npm-pack-install-'));
    try {
      const { stdout: packOut } = await execFileAsync(
        'npm',
        ['pack', '--pack-destination', packDir, '--json'],
        { cwd: repoRoot },
      );
      const [packResult] = JSON.parse(packOut) as { filename: string }[];
      if (packResult === undefined) {
        throw new Error('npm pack produced no tarball');
      }
      const tarballPath = join(packDir, packResult.filename);

      await writeFile(join(installDir, 'package.json'), '{"private": true}\n', 'utf8');
      // Real network install: this is the one place a devDependency
      // wrongly imported at runtime, or a broken `files` list, actually
      // shows up -- `npm install <tgz>` resolves only what the tarball's
      // own package.json declares as (transitive) dependencies.
      await execFileAsync('npm', ['install', tarballPath], { cwd: installDir, timeout: 180_000 });

      const speckifyBin = join(installDir, 'node_modules', '.bin', 'speckify');

      const help = await execFileAsync(speckifyBin, ['--help']);
      expect(help.stdout).toContain('speckify');

      await cp(join(exampleDir, 'openapi.yaml'), join(installDir, 'openapi.yaml'));
      const speckifyYaml = [
        'contracts:',
        '  - name: pet-shelter-npm-pack-e2e',
        '    spec: ./openapi.yaml',
        '    typescript:',
        '      package: "@speckify-npm-pack-e2e/pet-shelter"',
        '      client: true',
        '      server: true',
        ...(uvAvailable
          ? [
              '    python:',
              '      package: speckify-npm-pack-e2e-pet-shelter',
              '      client: true',
              '      server: true',
              '',
            ]
          : ['']),
        'publish:',
        '  githubPackages:',
        '    owner: speckify-npm-pack-e2e',
        '',
      ].join('\n');
      await writeFile(join(installDir, 'speckify.yaml'), speckifyYaml, 'utf8');

      await execFileAsync(speckifyBin, ['build', '-c', 'speckify.yaml'], {
        cwd: installDir,
        env: { ...process.env, GITHUB_TOKEN: '' },
      });

      const tsDist = await readdir(
        join(installDir, '.speckify', 'out', 'pet-shelter-npm-pack-e2e', 'typescript', 'dist'),
      );
      expect(tsDist.length).toBeGreaterThan(0);

      if (uvAvailable) {
        const pyDist = await readdir(
          join(installDir, '.speckify', 'out', 'pet-shelter-npm-pack-e2e', 'python', 'dist'),
        );
        expect(pyDist.some((name) => name.endsWith('.whl'))).toBe(true);
        expect(pyDist.some((name) => name.endsWith('.tar.gz'))).toBe(true);
      }
    } finally {
      await rm(packDir, { recursive: true, force: true });
      await rm(installDir, { recursive: true, force: true });
    }
  }, 300_000);
});

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bundleSpec } from './index.js';
import { PathTraversalError } from './errors.js';
import { resolveRepoRoot, type ProcessRunner } from './repo-root.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

describe('resolveRepoRoot', () => {
  it("returns git rev-parse --show-toplevel's trimmed output", async () => {
    const runProcess: ProcessRunner = vi.fn().mockResolvedValue({
      stdout: '/repo/root\n',
      stderr: '',
    });

    const result = await resolveRepoRoot('/repo/root/packages/api', runProcess);

    expect(result).toBe('/repo/root');
    expect(runProcess).toHaveBeenCalledWith('git', ['rev-parse', '--show-toplevel'], {
      cwd: '/repo/root/packages/api',
    });
  });

  it('falls back to configDir when git rejects (not a repo, or git unavailable)', async () => {
    const runProcess: ProcessRunner = vi.fn().mockRejectedValue(new Error('not a git repository'));

    const result = await resolveRepoRoot('/some/config/dir', runProcess);

    expect(result).toBe('/some/config/dir');
  });

  it('falls back to configDir when git prints nothing', async () => {
    const runProcess: ProcessRunner = vi.fn().mockResolvedValue({ stdout: '   \n', stderr: '' });

    const result = await resolveRepoRoot('/some/config/dir', runProcess);

    expect(result).toBe('/some/config/dir');
  });

  describe('against a real git repository', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
      await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('resolves the real repository root from a nested subdirectory', async () => {
      const repo = await mkdtemp(join(tmpdir(), 'speckify-repo-root-'));
      tempDirs.push(repo);
      await git(repo, ['init', '--quiet']);
      const configDir = join(repo, 'contracts', 'api');
      await mkdir(configDir, { recursive: true });

      const result = await resolveRepoRoot(configDir);

      expect(result).toBe(await realpath(repo));
    });

    it('falls back to configDir for a directory outside any git repository', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'speckify-no-repo-'));
      tempDirs.push(outside);

      const result = await resolveRepoRoot(outside);

      expect(result).toBe(outside);
    });
  });
});

// The acceptance criteria in plain terms: a spec in a subdir referencing
// a sibling-dir schema *within the repo* passes; a $ref that escapes the
// repo root fails. The previous containment root was the
// config directory, which got the first half of this backwards (a sibling
// package elsewhere in the same repo -- a normal shared-schema layout --
// was refused as "path traversal") without actually enforcing the second
// half (nothing stopped an escape past the config dir as long as it
// stayed under some other ancestor).
describe('resolveRepoRoot + bundleSpec: repo-root containment (S7)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('bundles a spec whose $ref reaches a sibling directory within the repo, outside the config dir', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'speckify-repo-root-contain-'));
    tempDirs.push(repo);
    await git(repo, ['init', '--quiet']);

    const configDir = join(repo, 'contracts', 'api');
    await mkdir(configDir, { recursive: true });
    const sharedDir = join(repo, 'shared');
    await mkdir(sharedDir, { recursive: true });
    await writeFile(
      join(sharedDir, 'widget.schema.json'),
      JSON.stringify({ type: 'object', properties: { id: { type: 'string' } } }),
      'utf8',
    );
    await writeFile(
      join(configDir, 'openapi.yaml'),
      [
        'openapi: 3.0.3',
        'info:',
        '  title: Widgets API',
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
        "                $ref: '../../shared/widget.schema.json'",
        '',
      ].join('\n'),
      'utf8',
    );

    const repoRoot = await resolveRepoRoot(configDir);
    const result = await bundleSpec(join(configDir, 'openapi.yaml'), { repoRoot });

    const doc = JSON.parse(result) as { paths: { '/widgets': { get: { responses: unknown } } } };
    expect(doc.paths['/widgets'].get.responses).toBeDefined();
  });

  it('refuses a $ref that escapes the repo root even though it still escapes the config dir', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'speckify-repo-root-escape-'));
    tempDirs.push(repo);
    await git(repo, ['init', '--quiet']);

    const configDir = join(repo, 'contracts', 'api');
    await mkdir(configDir, { recursive: true });

    // A schema that lives entirely outside the repo -- not just outside
    // the config dir.
    const outsideDir = await mkdtemp(join(tmpdir(), 'speckify-repo-root-outside-'));
    tempDirs.push(outsideDir);
    await writeFile(
      join(outsideDir, 'widget.schema.json'),
      JSON.stringify({ type: 'object' }),
      'utf8',
    );
    await writeFile(
      join(configDir, 'openapi.yaml'),
      [
        'openapi: 3.0.3',
        'info:',
        '  title: Widgets API',
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
        `                $ref: '${outsideDir}/widget.schema.json'`,
        '',
      ].join('\n'),
      'utf8',
    );

    const repoRoot = await resolveRepoRoot(configDir);
    await expect(bundleSpec(join(configDir, 'openapi.yaml'), { repoRoot })).rejects.toThrow(
      PathTraversalError,
    );
  });
});

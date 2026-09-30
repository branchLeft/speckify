import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BuildError } from './errors.js';
import { runUvBuild } from './build.js';

function fakeChildProcess(): {
  child: ChildProcess;
  emitClose: (code: number | null) => void;
  emitStderr: (s: string) => void;
} {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stderr = new EventEmitter();
  Object.assign(child, { stderr });
  return {
    child,
    emitClose: (code) => child.emit('close', code),
    emitStderr: (s) => stderr.emit('data', Buffer.from(s)),
  };
}

describe('runUvBuild', () => {
  let outputDir: string;

  afterEach(async () => {
    if (outputDir) {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('rejects with BuildError when uv build exits non-zero', async () => {
    const fake = fakeChildProcess();
    const spawnFn = vi.fn(() => fake.child) as unknown as typeof import('node:child_process').spawn;

    const promise = runUvBuild({
      projectDir: '/nonexistent',
      env: { PATH: process.env.PATH ?? '' },
      uvPath: '/usr/bin/uv',
      spawnFn,
    });
    fake.emitStderr('build blew up');
    fake.emitClose(1);

    await expect(promise).rejects.toThrow(BuildError);
    await expect(promise).rejects.toThrow(/build blew up/);
  });

  it('rejects with BuildError when the process cannot start', async () => {
    const fake = fakeChildProcess();
    const spawnFn = vi.fn(() => fake.child) as unknown as typeof import('node:child_process').spawn;

    const promise = runUvBuild({
      projectDir: '/nonexistent',
      env: { PATH: process.env.PATH ?? '' },
      uvPath: '/usr/bin/uv',
      spawnFn,
    });
    fake.child.emit('error', new Error('ENOENT'));

    await expect(promise).rejects.toThrow(BuildError);
  });

  it('rejects with BuildError when uv build exits 0 but produces no wheel or sdist', async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'speckify-build-out-'));
    const fake = fakeChildProcess();
    const spawnFn = vi.fn(() => fake.child) as unknown as typeof import('node:child_process').spawn;

    const promise = runUvBuild({
      projectDir: '/nonexistent',
      outputDir,
      env: { PATH: process.env.PATH ?? '' },
      uvPath: '/usr/bin/uv',
      spawnFn,
    });
    fake.emitClose(0);

    await expect(promise).rejects.toThrow(/did not produce both a wheel and an sdist/);
  });

  it('rejects when only a wheel (no sdist) was produced', async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'speckify-build-out-'));
    await writeFile(join(outputDir, 'pkg-0.1.0-py3-none-any.whl'), '', 'utf8');
    const fake = fakeChildProcess();
    const spawnFn = vi.fn(() => fake.child) as unknown as typeof import('node:child_process').spawn;

    const promise = runUvBuild({
      projectDir: '/nonexistent',
      outputDir,
      env: { PATH: process.env.PATH ?? '' },
      uvPath: '/usr/bin/uv',
      spawnFn,
    });
    fake.emitClose(0);

    await expect(promise).rejects.toThrow(BuildError);
  });

  it('returns both artifacts, correctly kinded, on success', async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'speckify-build-out-'));
    await writeFile(join(outputDir, 'pkg-0.1.0-py3-none-any.whl'), '', 'utf8');
    await writeFile(join(outputDir, 'pkg-0.1.0.tar.gz'), '', 'utf8');
    const fake = fakeChildProcess();
    const spawnFn = vi.fn(() => fake.child) as unknown as typeof import('node:child_process').spawn;

    const promise = runUvBuild({
      projectDir: '/nonexistent',
      outputDir,
      env: { PATH: process.env.PATH ?? '' },
      uvPath: '/usr/bin/uv',
      spawnFn,
    });
    fake.emitClose(0);

    const artifacts = await promise;
    expect(artifacts.sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { path: join(outputDir, 'pkg-0.1.0.tar.gz'), kind: 'sdist' },
      { path: join(outputDir, 'pkg-0.1.0-py3-none-any.whl'), kind: 'wheel' },
    ]);
  });
});

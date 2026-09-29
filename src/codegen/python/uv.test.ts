import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { SubprocessError, UvNotFoundError } from './errors.js';
import { resolveUv, runUv, runUvOrThrow } from './uv.js';

/** A minimal fake of a spawned child process good enough to drive `runUv`. */
function fakeChildProcess(): { child: ChildProcess; emitClose: (code: number | null) => void; emitStdout: (s: string) => void; emitStderr: (s: string) => void } {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.assign(child, { stdout, stderr });
  return {
    child,
    emitClose: (code) => child.emit('close', code),
    emitStdout: (s) => stdout.emit('data', Buffer.from(s)),
    emitStderr: (s) => stderr.emit('data', Buffer.from(s)),
  };
}

describe('resolveUv', () => {
  it('throws UvNotFoundError when PATH has no executable uv', async () => {
    await expect(resolveUv({ env: { PATH: '/nonexistent-dir-xyz' } })).rejects.toThrow(UvNotFoundError);
  });

  it('finds the real uv on the actual PATH', async () => {
    await expect(resolveUv()).resolves.toMatch(/uv$/);
  });
});

describe('runUv', () => {
  it('runs "uv run --frozen <args>" and captures stdout', async () => {
    const fake = fakeChildProcess();
    const spawnFn = vi.fn(() => fake.child) as unknown as typeof import('node:child_process').spawn;

    const promise = runUv(['some-tool', '--flag'], '/work', {
      env: { PATH: '/usr/bin' },
      uvPath: '/usr/bin/uv',
      spawnFn,
    });
    fake.emitStdout('hello');
    fake.emitClose(0);

    const result = await promise;
    expect(result).toEqual({ stdout: 'hello', stderr: '', exitCode: 0 });
    expect(spawnFn).toHaveBeenCalledWith(
      '/usr/bin/uv',
      ['run', '--frozen', 'some-tool', '--flag'],
      expect.objectContaining({ cwd: '/work' }),
    );
  });

  it('resolves (not rejects) with a non-zero exit code and captured stderr', async () => {
    const fake = fakeChildProcess();
    const spawnFn = vi.fn(() => fake.child) as unknown as typeof import('node:child_process').spawn;

    const promise = runUv(['broken'], '/work', { env: { PATH: '/usr/bin' }, uvPath: '/usr/bin/uv', spawnFn });
    fake.emitStderr('boom');
    fake.emitClose(1);

    await expect(promise).resolves.toEqual({ stdout: '', stderr: 'boom', exitCode: 1 });
  });

  it('rejects with SubprocessError when the process itself cannot start', async () => {
    const fake = fakeChildProcess();
    const spawnFn = vi.fn(() => fake.child) as unknown as typeof import('node:child_process').spawn;

    const promise = runUv(['whatever'], '/work', { env: { PATH: '/usr/bin' }, uvPath: '/usr/bin/uv', spawnFn });
    fake.child.emit('error', new Error('ENOENT'));

    await expect(promise).rejects.toThrow(SubprocessError);
  });
});

describe('runUvOrThrow', () => {
  it('throws SubprocessError on a non-zero exit', async () => {
    const fake = fakeChildProcess();
    const spawnFn = vi.fn(() => fake.child) as unknown as typeof import('node:child_process').spawn;

    const promise = runUvOrThrow(['broken'], '/work', { env: { PATH: '/usr/bin' }, uvPath: '/usr/bin/uv', spawnFn });
    fake.emitStderr('bad input');
    fake.emitClose(2);

    await expect(promise).rejects.toThrow(/bad input/);
  });

  it('resolves normally on exit code 0', async () => {
    const fake = fakeChildProcess();
    const spawnFn = vi.fn(() => fake.child) as unknown as typeof import('node:child_process').spawn;

    const promise = runUvOrThrow(['ok'], '/work', { env: { PATH: '/usr/bin' }, uvPath: '/usr/bin/uv', spawnFn });
    fake.emitClose(0);

    await expect(promise).resolves.toEqual({ stdout: '', stderr: '', exitCode: 0 });
  });
});

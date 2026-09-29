import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { resolveOasdiffBinary } from './binary.js';
import { OasdiffError } from './errors.js';
import { runOasdiffChangelog, type ProcessRunner } from './runner.js';

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));

describe('runOasdiffChangelog', () => {
  it('runs the pinned oasdiff changelog command and parses its JSON output', async () => {
    const changes = [
      {
        id: 'response-required-property-removed',
        text: 'removed x',
        level: 3,
        operation: 'GET',
        path: '/widgets',
      },
    ];
    const runProcess: ProcessRunner = vi.fn(async () =>
      Promise.resolve({ stdout: JSON.stringify(changes), stderr: '' }),
    );

    const result = await runOasdiffChangelog({
      oasdiffPath: '/bin/oasdiff',
      baseSpecPath: 'base.json',
      revisionSpecPath: 'revision.json',
      runProcess,
    });

    expect(result).toEqual(changes);
    expect(runProcess).toHaveBeenCalledWith('/bin/oasdiff', [
      'changelog',
      'base.json',
      'revision.json',
      '--format',
      'json',
      '--flatten-allof',
    ]);
  });

  it('always passes --flatten-allof, whatever the inputs', async () => {
    const runProcess: ProcessRunner = vi.fn(async () =>
      Promise.resolve({ stdout: '[]', stderr: '' }),
    );

    await runOasdiffChangelog({
      oasdiffPath: '/bin/oasdiff',
      baseSpecPath: 'a.json',
      revisionSpecPath: 'b.json',
      runProcess,
    });

    const call = vi.mocked(runProcess).mock.calls[0];
    expect(call?.[1]).toContain('--flatten-allof');
  });

  it('treats an empty stdout as no changes', async () => {
    const runProcess: ProcessRunner = vi.fn(async () =>
      Promise.resolve({ stdout: '', stderr: '' }),
    );

    const result = await runOasdiffChangelog({
      oasdiffPath: '/bin/oasdiff',
      baseSpecPath: 'base.json',
      revisionSpecPath: 'revision.json',
      runProcess,
    });

    expect(result).toEqual([]);
  });

  it('wraps a rejecting runProcess in OasdiffError', async () => {
    const runProcess: ProcessRunner = vi.fn(() => {
      throw new Error('spawn failed');
    });

    await expect(
      runOasdiffChangelog({
        oasdiffPath: '/bin/oasdiff',
        baseSpecPath: 'base.json',
        revisionSpecPath: 'revision.json',
        runProcess,
      }),
    ).rejects.toThrow(OasdiffError);
  });

  it('wraps a non-Error rejection (e.g. a plain thrown string) in OasdiffError', async () => {
    const runProcess: ProcessRunner = vi.fn(() => {
      // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error -- deliberately non-Error, to exercise the String(error) fallback
      throw 'spawn failed, not an Error instance';
    });

    await expect(
      runOasdiffChangelog({
        oasdiffPath: '/bin/oasdiff',
        baseSpecPath: 'base.json',
        revisionSpecPath: 'revision.json',
        runProcess,
      }),
    ).rejects.toThrow(/spawn failed, not an Error instance/);
  });

  it('throws OasdiffError when stdout is not valid JSON', async () => {
    const runProcess: ProcessRunner = vi.fn(async () =>
      Promise.resolve({ stdout: 'not json', stderr: '' }),
    );

    await expect(
      runOasdiffChangelog({
        oasdiffPath: '/bin/oasdiff',
        baseSpecPath: 'base.json',
        revisionSpecPath: 'revision.json',
        runProcess,
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('throws OasdiffError when the JSON does not match the changelog shape', async () => {
    const runProcess: ProcessRunner = vi.fn(async () =>
      Promise.resolve({ stdout: JSON.stringify([{ notAChange: true }]), stderr: '' }),
    );

    await expect(
      runOasdiffChangelog({
        oasdiffPath: '/bin/oasdiff',
        baseSpecPath: 'base.json',
        revisionSpecPath: 'revision.json',
        runProcess,
      }),
    ).rejects.toThrow(/did not match the expected changelog shape/);
  });
});

describe('runOasdiffChangelog against the real oasdiff binary', () => {
  it('throws OasdiffError, never an empty changelog, when the revision spec has a dangling $ref', async () => {
    let oasdiffPath: string;
    try {
      oasdiffPath = await resolveOasdiffBinary({
        cacheDir: join(homedir(), '.cache', 'speckify', 'oasdiff'),
      });
    } catch {
      // No cached or downloadable binary in this environment (offline CI, a
      // fresh machine with no network) — nothing further to prove here.
      return;
    }

    // oasdiff exits non-zero with empty stdout and the reason on stderr for
    // a spec it cannot load at all (confirmed against the real 1.32.1
    // binary: exit code 102). Silently treating that as "no changes" is
    // exactly the under-bump this test guards against.
    await expect(
      runOasdiffChangelog({
        oasdiffPath,
        baseSpecPath: `${fixturesDir}allof-nullable-base.json`,
        revisionSpecPath: `${fixturesDir}dangling-ref-revision.json`,
      }),
    ).rejects.toThrow(OasdiffError);
  });

  it('reports the allOf-nullable fixture as ERR (level 3), which --flatten-allof alone makes true', async () => {
    let oasdiffPath: string;
    try {
      oasdiffPath = await resolveOasdiffBinary({
        cacheDir: join(homedir(), '.cache', 'speckify', 'oasdiff'),
      });
    } catch {
      // No cached or downloadable binary in this environment (offline CI, a
      // fresh machine with no network) — nothing further to prove here.
      return;
    }

    const result = await runOasdiffChangelog({
      oasdiffPath,
      baseSpecPath: `${fixturesDir}allof-nullable-base.json`,
      revisionSpecPath: `${fixturesDir}allof-nullable-revision.json`,
    });

    const nullableChange = result.find(
      (change) => change.id === 'response-property-became-nullable',
    );
    expect(nullableChange).toBeDefined();
    // Confirmed manually against the real binary: running this identical
    // pair without --flatten-allof reports the same rule id at level 2
    // (WARN), not 3 (ERR) — a genuinely breaking change that would
    // under-bump semver if the flag were ever dropped.
    expect(nullableChange?.level).toBe(3);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { OasdiffError } from './errors.js';
import { runOasdiffChangelog, type ProcessRunner } from './runner.js';

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
    ]);
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

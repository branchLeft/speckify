import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runOasdiffChangelog } from './runner.js';

// Exercises the default process runner (no injected runProcess), including
// its recovery of stdout from a non-zero exit -- oasdiff's own changelog
// command exits non-zero when it finds changes, which is expected, not a
// failure.
describe('runOasdiffChangelog with the default process runner', () => {
  let dir: string;
  let scriptPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'speckify-runner-'));
    scriptPath = join(dir, 'fake-oasdiff.sh');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('recovers stdout from a real process that exits non-zero', async () => {
    await writeFile(
      scriptPath,
      [
        '#!/bin/sh',
        'echo \'[{"id":"endpoint-added","text":"added /pets","level":1}]\'',
        'exit 1',
        '',
      ].join('\n'),
    );
    await chmod(scriptPath, 0o755);

    const result = await runOasdiffChangelog({
      oasdiffPath: scriptPath,
      baseSpecPath: 'base.json',
      revisionSpecPath: 'revision.json',
    });

    expect(result).toEqual([{ id: 'endpoint-added', text: 'added /pets', level: 1 }]);
  });

  it('throws OasdiffError when the binary does not exist', async () => {
    await expect(
      runOasdiffChangelog({
        oasdiffPath: join(dir, 'does-not-exist'),
        baseSpecPath: 'base.json',
        revisionSpecPath: 'revision.json',
      }),
    ).rejects.toThrow(/oasdiff failed to run/);
  });
});

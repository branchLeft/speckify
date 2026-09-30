import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runOasdiffChangelog } from './runner.js';

// Exercises the default process runner (no injected runProcess). Confirmed
// against the real oasdiff 1.32.1 binary: it exits 0 whether or not it
// found changes, and only exits non-zero on a genuine failure (e.g. a
// dangling $ref), with empty stdout and the reason on stderr. So any
// non-zero exit is a hard error here, never "no changes" -- even if the
// process happened to write something to stdout first.
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

  it('throws, never returning the changelog, for a real process that exits non-zero even with populated stdout', async () => {
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

    await expect(
      runOasdiffChangelog({
        oasdiffPath: scriptPath,
        baseSpecPath: 'base.json',
        revisionSpecPath: 'revision.json',
      }),
    ).rejects.toThrow(/oasdiff failed to run/);
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

import { describe, expect, it } from 'vitest';

import { defaultProcessRunner } from './process-runner.js';

describe('defaultProcessRunner', () => {
  it('runs a real subprocess and resolves with its stdout', async () => {
    const result = await defaultProcessRunner(process.execPath, ['-e', "console.log('ok')"]);
    expect(result.stdout.trim()).toBe('ok');
  });

  it('rejects when the subprocess exits non-zero', async () => {
    await expect(
      defaultProcessRunner(process.execPath, ['-e', 'process.exit(1)']),
    ).rejects.toThrow();
  });

  it('passes cwd and env through to the subprocess', async () => {
    const result = await defaultProcessRunner(
      process.execPath,
      ['-e', 'console.log(process.env.SPECKIFY_TEST_VAR)'],
      { env: { ...process.env, SPECKIFY_TEST_VAR: 'from-options' } },
    );
    expect(result.stdout.trim()).toBe('from-options');
  });
});

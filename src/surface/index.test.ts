import { describe, expect, it } from 'vitest';

import { compareGeneratedSurfaces, reportOf } from './index.js';

describe('compareGeneratedSurfaces', () => {
  it('refuses a Python target without the toolchain directory', async () => {
    await expect(
      compareGeneratedSurfaces({
        previousSpec: '{}',
        currentSpec: '{"a":1}',
        targets: { python: { client: true, server: false } },
      }),
    ).rejects.toThrow('Python toolchain directory');
  });

  it('reports none for identical specs without generating anything', async () => {
    const report = await compareGeneratedSurfaces({
      previousSpec: '{"openapi":"3.0.3"}',
      currentSpec: '{"openapi":"3.0.3"}',
      targets: { typescript: { client: true, server: false } },
    });
    expect(report).toEqual({ bump: 'none', changes: [] });
  });
});

describe('reportOf', () => {
  it('is the highest change, none when there is none', () => {
    const change = { language: 'python', symbol: 'm', reason: 'r' } as const;
    expect(reportOf([]).bump).toBe('none');
    expect(reportOf([{ ...change, bump: 'minor' }]).bump).toBe('minor');
    expect(
      reportOf([
        { ...change, bump: 'minor' },
        { ...change, bump: 'major' },
      ]).bump,
    ).toBe('major');
  });
});

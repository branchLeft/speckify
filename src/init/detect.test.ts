import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectOpenapiSpecs } from './detect.js';

describe('detectOpenapiSpecs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'speckify-detect-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds openapi.yaml, openapi.json and prefixed variants, sorted', async () => {
    await writeFile(join(dir, 'openapi.json'), '{}');
    await writeFile(join(dir, 'openapi-orders.yaml'), 'x');
    await writeFile(join(dir, 'notes.md'), 'x');
    await writeFile(join(dir, 'OpenAPI.yml'), 'x');

    const found = await detectOpenapiSpecs(dir);
    expect(found).toEqual(['OpenAPI.yml', 'openapi-orders.yaml', 'openapi.json']);
  });

  it('returns an empty array when nothing matches', async () => {
    await writeFile(join(dir, 'notes.md'), 'x');
    expect(await detectOpenapiSpecs(dir)).toEqual([]);
  });

  it('ignores directories even if named like a spec', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'openapi.yaml'));
    expect(await detectOpenapiSpecs(dir)).toEqual([]);
  });
});

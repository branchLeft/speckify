import { gzipSync } from 'node:zlib';

import { pack } from 'tar-stream';
import { describe, expect, it } from 'vitest';

import { extractTarGzEntry } from './extract-tar-entry.js';

async function makeTarGz(entries: Record<string, string>): Promise<Buffer> {
  const packer = pack();
  for (const [name, content] of Object.entries(entries)) {
    packer.entry({ name }, content);
  }
  packer.finalize();

  const chunks: Buffer[] = [];
  for await (const chunk of packer as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return gzipSync(Buffer.concat(chunks));
}

describe('extractTarGzEntry', () => {
  it('extracts the matching entry from a gzip-compressed tarball', async () => {
    const tarGz = await makeTarGz({
      'package/package.json': '{"name":"x"}',
      'package/openapi.json': '{"openapi":"3.0.3"}',
    });

    const result = await extractTarGzEntry(tarGz, (name) => name === 'package/openapi.json');
    expect(result?.toString('utf8')).toBe('{"openapi":"3.0.3"}');
  });

  it('returns null when no entry matches', async () => {
    const tarGz = await makeTarGz({ 'package/package.json': '{}' });

    const result = await extractTarGzEntry(tarGz, (name) => name === 'package/openapi.json');
    expect(result).toBeNull();
  });

  it('skips non-matching entries without buffering their content', async () => {
    const tarGz = await makeTarGz({
      'package/big.txt': 'x'.repeat(10_000),
      'package/openapi.json': '{"openapi":"3.1.0"}',
    });

    const result = await extractTarGzEntry(tarGz, (name) => name === 'package/openapi.json');
    expect(result?.toString('utf8')).toBe('{"openapi":"3.1.0"}');
  });
});

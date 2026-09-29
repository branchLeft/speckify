import { gzipSync } from 'node:zlib';

import { pack } from 'tar-stream';
import { describe, expect, it, vi } from 'vitest';

import { RecordError } from './errors.js';
import { createNpmRegistryRecord } from './npm.js';
import type { FetchLike } from './types.js';

async function makeTarballWithSpec(
  spec: unknown,
  packageJson: unknown = { name: 'orders-api' },
): Promise<Buffer> {
  const packer = pack();
  packer.entry({ name: 'package/package.json' }, JSON.stringify(packageJson));
  packer.entry({ name: 'package/openapi.json' }, JSON.stringify(spec));
  packer.finalize();

  const chunks: Buffer[] = [];
  for await (const chunk of packer as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return gzipSync(Buffer.concat(chunks));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createNpmRegistryRecord', () => {
  it('returns null when the package has never been published', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response('', { status: 404 })),
    );
    const record = createNpmRegistryRecord({ registryUrl: 'https://npm.example', fetchImpl });

    await expect(record.latest('@acme/orders-api')).resolves.toBeNull();
  });

  it('resolves the latest version and extracts its published spec', async () => {
    const tarball = await makeTarballWithSpec({ openapi: '3.0.3', info: { version: '0.0.0' } });

    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      if (url.endsWith('/openapi-orders-api-1.2.3.tgz')) {
        return Promise.resolve(
          new Response(new Uint8Array(tarball), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          'dist-tags': { latest: '1.2.3' },
          versions: {
            '1.2.3': {
              dist: { tarball: 'https://npm.example/orders-api/-/openapi-orders-api-1.2.3.tgz' },
            },
          },
        }),
      );
    });

    const record = createNpmRegistryRecord({
      registryUrl: 'https://npm.example',
      token: 'a-token',
      fetchImpl,
    });

    const result = await record.latest('@acme/orders-api');
    expect(result?.version).toBe('1.2.3');
    expect(result?.bundledSpec).toContain('"openapi": "3.0.3"');

    const packumentCall = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(packumentCall[0]).toBe('https://npm.example/%40acme%2Forders-api');
    const headers = packumentCall[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer a-token');
  });

  it('reads the generating speckifyVersion back from package/package.json (B3)', async () => {
    const tarball = await makeTarballWithSpec(
      { openapi: '3.0.3', info: { version: '0.0.0' } },
      { name: 'orders-api', speckify: { speckifyVersion: '0.4.1' } },
    );

    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      if (url.endsWith('.tgz')) {
        return Promise.resolve(new Response(new Uint8Array(tarball), { status: 200 }));
      }
      return Promise.resolve(
        jsonResponse({
          'dist-tags': { latest: '1.2.3' },
          versions: { '1.2.3': { dist: { tarball: 'https://npm.example/x.tgz' } } },
        }),
      );
    });
    const record = createNpmRegistryRecord({ registryUrl: 'https://npm.example', fetchImpl });

    const result = await record.latest('@acme/orders-api');
    expect(result?.speckifyVersion).toBe('0.4.1');
  });

  it('treats a package.json with no speckify.speckifyVersion as an unknown generating version, not none (B3 fail-safe)', async () => {
    const tarball = await makeTarballWithSpec(
      { openapi: '3.0.3', info: { version: '0.0.0' } },
      { name: 'orders-api' },
    );

    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      if (url.endsWith('.tgz')) {
        return Promise.resolve(new Response(new Uint8Array(tarball), { status: 200 }));
      }
      return Promise.resolve(
        jsonResponse({
          'dist-tags': { latest: '1.2.3' },
          versions: { '1.2.3': { dist: { tarball: 'https://npm.example/x.tgz' } } },
        }),
      );
    });
    const record = createNpmRegistryRecord({ registryUrl: 'https://npm.example', fetchImpl });

    const result = await record.latest('@acme/orders-api');
    expect(result?.speckifyVersion).toBeNull();
  });

  it('throws RecordError when the registry responds with a non-404 error', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response('', { status: 500 })),
    );
    const record = createNpmRegistryRecord({ registryUrl: 'https://npm.example', fetchImpl });

    await expect(record.latest('@acme/orders-api')).rejects.toThrow(RecordError);
  });

  it('throws RecordError when the registry returns a malformed (non-object) packument', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response('null', { status: 200 })),
    );
    const record = createNpmRegistryRecord({ registryUrl: 'https://npm.example', fetchImpl });

    await expect(record.latest('@acme/orders-api')).rejects.toThrow(/malformed packument/);
  });

  it('falls back to the global fetch when no fetchImpl is given', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 404 }));
    try {
      const record = createNpmRegistryRecord({ registryUrl: 'https://npm.example' });
      await expect(record.latest('@acme/orders-api')).resolves.toBeNull();
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws RecordError when the packument has no dist-tags.latest', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => Promise.resolve(jsonResponse({})));
    const record = createNpmRegistryRecord({ registryUrl: 'https://npm.example', fetchImpl });

    await expect(record.latest('@acme/orders-api')).rejects.toThrow(/dist-tags\.latest/);
  });

  it('throws RecordError when the latest version has no tarball URL', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(jsonResponse({ 'dist-tags': { latest: '1.0.0' }, versions: {} })),
    );
    const record = createNpmRegistryRecord({ registryUrl: 'https://npm.example', fetchImpl });

    await expect(record.latest('@acme/orders-api')).rejects.toThrow(/dist\.tarball/);
  });

  it('throws RecordError when the tarball download fails', async () => {
    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      if (url.includes('.tgz')) {
        return Promise.resolve(new Response('', { status: 500 }));
      }
      return Promise.resolve(
        jsonResponse({
          'dist-tags': { latest: '1.0.0' },
          versions: { '1.0.0': { dist: { tarball: 'https://npm.example/x.tgz' } } },
        }),
      );
    });
    const record = createNpmRegistryRecord({ registryUrl: 'https://npm.example', fetchImpl });

    await expect(record.latest('@acme/orders-api')).rejects.toThrow(/could not download tarball/);
  });

  it('throws RecordError when the tarball has no package/openapi.json', async () => {
    const packer = pack();
    packer.entry({ name: 'package/package.json' }, '{}');
    packer.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of packer as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const tarball = gzipSync(Buffer.concat(chunks));

    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      if (url.includes('.tgz')) {
        return Promise.resolve(new Response(new Uint8Array(tarball), { status: 200 }));
      }
      return Promise.resolve(
        jsonResponse({
          'dist-tags': { latest: '1.0.0' },
          versions: { '1.0.0': { dist: { tarball: 'https://npm.example/x.tgz' } } },
        }),
      );
    });
    const record = createNpmRegistryRecord({ registryUrl: 'https://npm.example', fetchImpl });

    await expect(record.latest('@acme/orders-api')).rejects.toThrow(
      /has no package\/openapi\.json/,
    );
  });
});

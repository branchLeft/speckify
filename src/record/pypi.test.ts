import { crc32 } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { RecordError } from './errors.js';
import { createPyPiRegistryRecord } from './pypi.js';
import type { FetchLike } from './types.js';

function makeWheel(fileName: string, content: string): Buffer {
  const nameBuffer = Buffer.from(fileName, 'utf8');
  const contentBuffer = Buffer.from(content, 'utf8');
  const checksum = crc32(contentBuffer);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(contentBuffer.length, 18);
  localHeader.writeUInt32LE(contentBuffer.length, 22);
  localHeader.writeUInt16LE(nameBuffer.length, 26);
  const localEntry = Buffer.concat([localHeader, nameBuffer, contentBuffer]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(contentBuffer.length, 20);
  centralHeader.writeUInt32LE(contentBuffer.length, 24);
  centralHeader.writeUInt16LE(nameBuffer.length, 28);
  const centralEntry = Buffer.concat([centralHeader, nameBuffer]);

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralEntry.length, 12);
  endRecord.writeUInt32LE(localEntry.length, 16);

  return Buffer.concat([localEntry, centralEntry, endRecord]);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createPyPiRegistryRecord', () => {
  it('returns null when the project has never been published', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response('', { status: 404 })),
    );
    const record = createPyPiRegistryRecord({ fetchImpl });

    await expect(record.latest('orders-api')).resolves.toBeNull();
  });

  it('resolves the current version and extracts its published spec', async () => {
    const wheel = makeWheel(
      'orders_api/openapi.json',
      '{"openapi":"3.1.0","info":{"version":"0.0.0"}}',
    );

    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      if (url.endsWith('.whl')) {
        return Promise.resolve(new Response(new Uint8Array(wheel), { status: 200 }));
      }
      return Promise.resolve(
        jsonResponse({
          info: { version: '2.0.0' },
          urls: [
            { packagetype: 'sdist', url: 'https://pypi.example/orders-api-2.0.0.tar.gz' },
            {
              packagetype: 'bdist_wheel',
              url: 'https://pypi.example/orders_api-2.0.0-py3-none-any.whl',
            },
          ],
        }),
      );
    });

    const record = createPyPiRegistryRecord({ indexUrl: 'https://pypi.example', fetchImpl });

    const result = await record.latest('orders-api');
    expect(result?.version).toBe('2.0.0');
    expect(result?.bundledSpec).toContain('"openapi": "3.1.0"');

    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(call[0]).toBe('https://pypi.example/pypi/orders-api/json');
  });

  it('throws RecordError when PyPI responds with a non-404 error', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response('', { status: 503 })),
    );
    const record = createPyPiRegistryRecord({ fetchImpl });

    await expect(record.latest('orders-api')).rejects.toThrow(RecordError);
  });

  it('throws RecordError when there is no wheel release for the current version', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(
        jsonResponse({
          info: { version: '2.0.0' },
          urls: [{ packagetype: 'sdist', url: 'https://pypi.example/orders-api-2.0.0.tar.gz' }],
        }),
      ),
    );
    const record = createPyPiRegistryRecord({ fetchImpl });

    await expect(record.latest('orders-api')).rejects.toThrow(/no wheel release/);
  });

  it('throws RecordError when the wheel download fails', async () => {
    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      if (url.endsWith('.whl')) {
        return Promise.resolve(new Response('', { status: 500 }));
      }
      return Promise.resolve(
        jsonResponse({
          info: { version: '2.0.0' },
          urls: [{ packagetype: 'bdist_wheel', url: 'https://pypi.example/x.whl' }],
        }),
      );
    });
    const record = createPyPiRegistryRecord({ fetchImpl });

    await expect(record.latest('orders-api')).rejects.toThrow(/could not download wheel/);
  });

  it('throws RecordError when the wheel has no openapi.json', async () => {
    const wheel = makeWheel('orders_api/__init__.py', '');

    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      if (url.endsWith('.whl')) {
        return Promise.resolve(new Response(new Uint8Array(wheel), { status: 200 }));
      }
      return Promise.resolve(
        jsonResponse({
          info: { version: '2.0.0' },
          urls: [{ packagetype: 'bdist_wheel', url: 'https://pypi.example/x.whl' }],
        }),
      );
    });
    const record = createPyPiRegistryRecord({ fetchImpl });

    await expect(record.latest('orders-api')).rejects.toThrow(/has no openapi\.json/);
  });
});

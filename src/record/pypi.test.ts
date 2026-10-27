import { crc32 } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { RecordError } from './errors.js';
import { createPyPiRegistryRecord } from './pypi.js';
import type { FetchLike } from './types.js';

function makeWheelWithFiles(files: readonly [string, string][]): Buffer {
  const localEntries: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let offset = 0;

  for (const [fileName, content] of files) {
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
    localEntries.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(contentBuffer.length, 20);
    centralHeader.writeUInt32LE(contentBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    const centralEntry = Buffer.concat([centralHeader, nameBuffer]);
    centralEntries.push(centralEntry);

    offset += localEntry.length;
  }

  const localSection = Buffer.concat(localEntries);
  const centralSection = Buffer.concat(centralEntries);

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralSection.length, 12);
  endRecord.writeUInt32LE(localSection.length, 16);

  return Buffer.concat([localSection, centralSection, endRecord]);
}

function makeWheel(fileName: string, content: string): Buffer {
  return makeWheelWithFiles([[fileName, content]]);
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

  it('reads the generating speckifyVersion back from the wheel (B3)', async () => {
    const wheel = makeWheelWithFiles([
      ['orders_api/openapi.json', '{"openapi":"3.1.0","info":{"version":"0.0.0"}}'],
      ['orders_api/speckify.json', '{"speckifyVersion":"0.4.1"}'],
    ]);

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
    const record = createPyPiRegistryRecord({ indexUrl: 'https://pypi.example', fetchImpl });

    const result = await record.latest('orders-api');
    expect(result?.speckifyVersion).toBe('0.4.1');
  });

  it('treats a wheel with no speckify.json as an unknown generating version, not none (B3 fail-safe)', async () => {
    const wheel = makeWheelWithFiles([
      ['orders_api/openapi.json', '{"openapi":"3.1.0","info":{"version":"0.0.0"}}'],
    ]);

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
    const record = createPyPiRegistryRecord({ indexUrl: 'https://pypi.example', fetchImpl });

    const result = await record.latest('orders-api');
    expect(result?.speckifyVersion).toBeNull();
  });

  it('throws RecordError when PyPI responds with a non-404 error', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response('', { status: 503 })),
    );
    const record = createPyPiRegistryRecord({ fetchImpl });

    await expect(record.latest('orders-api')).rejects.toThrow(RecordError);
  });

  it('throws RecordError when PyPI returns a malformed (non-object) project response', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(new Response('null', { status: 200 })),
    );
    const record = createPyPiRegistryRecord({ fetchImpl });

    await expect(record.latest('orders-api')).rejects.toThrow(/malformed project response/);
  });

  it('throws RecordError when the project response has no info.version', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => Promise.resolve(jsonResponse({})));
    const record = createPyPiRegistryRecord({ fetchImpl });

    await expect(record.latest('orders-api')).rejects.toThrow(/no info\.version/);
  });

  it('treats a project response with no urls field as having no wheel release', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      Promise.resolve(jsonResponse({ info: { version: '2.0.0' } })),
    );
    const record = createPyPiRegistryRecord({ fetchImpl });

    await expect(record.latest('orders-api')).rejects.toThrow(/no wheel release/);
  });

  it('falls back to the global fetch and the default index URL when neither is given', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 404 }));
    try {
      const record = createPyPiRegistryRecord();
      await expect(record.latest('orders-api')).resolves.toBeNull();
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://pypi.org/pypi/orders-api/json',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
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

  describe('deadlines', () => {
    const PROJECT_URL = 'https://pypi.example/pypi/orders-api/json';
    const WHEEL_URL = 'https://pypi.example/x.whl';
    const projectWithWheel = {
      info: { version: '2.0.0' },
      urls: [{ packagetype: 'bdist_wheel', url: WHEEL_URL }],
    };

    function stallUntilAborted(init: RequestInit | undefined): Promise<Response> {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    }

    function bodyStallingResponse(init: RequestInit | undefined): Response {
      const body = new ReadableStream<Uint8Array>({
        start(controller): void {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new Error('body aborted'));
          });
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }

    it('aborts a PyPI project lookup that stalls past the timeout, as a RecordError naming the URL', async () => {
      const fetchImpl: FetchLike = vi.fn((_url: string, init?: RequestInit) =>
        stallUntilAborted(init),
      );
      const record = createPyPiRegistryRecord({
        indexUrl: 'https://pypi.example',
        fetchImpl,
        timeoutMs: 50,
      });

      const error = await record.latest('orders-api').catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RecordError);
      expect((error as Error).message).toContain(PROJECT_URL);
    });

    it('wraps a PyPI project body that stalls past the timeout as a RecordError naming the URL', async () => {
      const fetchImpl: FetchLike = vi.fn((url: string, init?: RequestInit) =>
        Promise.resolve(url === PROJECT_URL ? bodyStallingResponse(init) : jsonResponse({})),
      );
      const record = createPyPiRegistryRecord({
        indexUrl: 'https://pypi.example',
        fetchImpl,
        timeoutMs: 50,
      });

      const error = await record.latest('orders-api').catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RecordError);
      expect((error as Error).message).toContain(PROJECT_URL);
    });

    it('aborts a wheel download that stalls past the timeout, as a RecordError naming the URL', async () => {
      const fetchImpl: FetchLike = vi.fn((url: string, init?: RequestInit) =>
        url === WHEEL_URL ? stallUntilAborted(init) : Promise.resolve(jsonResponse(projectWithWheel)),
      );
      const record = createPyPiRegistryRecord({
        indexUrl: 'https://pypi.example',
        fetchImpl,
        timeoutMs: 50,
      });

      const error = await record.latest('orders-api').catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RecordError);
      expect((error as Error).message).toContain(WHEEL_URL);
    });

    it('wraps a wheel body that stalls past the timeout as a RecordError naming the URL', async () => {
      const fetchImpl: FetchLike = vi.fn((url: string, init?: RequestInit) =>
        Promise.resolve(
          url === WHEEL_URL ? bodyStallingResponse(init) : jsonResponse(projectWithWheel),
        ),
      );
      const record = createPyPiRegistryRecord({
        indexUrl: 'https://pypi.example',
        fetchImpl,
        timeoutMs: 50,
      });

      const error = await record.latest('orders-api').catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RecordError);
      expect((error as Error).message).toContain(WHEEL_URL);
    });
  });
});

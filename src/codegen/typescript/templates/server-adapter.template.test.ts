import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createRequestListener,
  type HandledResponse,
  type ListenerOptions,
  type RouteDefinition,
} from './server-adapter.template.js';

async function withServer(
  listener: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(listener);
  await new Promise<void>((resolve) => {
    server.listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${String(port)}`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

describe('createRequestListener', () => {
  const getThingRoute: RouteDefinition = {
    id: 'getThing',
    method: 'GET',
    path: '/things/{id}',
    bodyMode: 'none',
    pathSchema: z.object({ id: z.string() }),
  };

  it('matches a path template, parses params and calls the handler', async () => {
    const handlers = {
      getThing: (request: { path: { id: string } }): Promise<HandledResponse> =>
        Promise.resolve({ status: 200, body: { id: request.path.id } }),
    };
    const listener = createRequestListener(handlers, [getThingRoute]);

    await withServer(listener, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/things/abc`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: 'abc' });
    });
  });

  it('returns 404 problem+json when no route matches', async () => {
    const listener = createRequestListener({}, [getThingRoute]);
    await withServer(listener, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/nope`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
    });
  });

  it('validates the request body and returns 400 with issues on failure', async () => {
    const route: RouteDefinition = {
      id: 'createPet',
      method: 'POST',
      path: '/pets',
      bodyMode: 'json',
      bodySchema: z.object({ name: z.string() }),
    };
    const listener = createRequestListener(
      { createPet: () => Promise.resolve<HandledResponse>({ status: 201, body: {} }) },
      [route],
    );

    await withServer(listener, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/pets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 42 }),
      });
      expect(res.status).toBe(400);
      const problem = (await res.json()) as { title: string; errors: unknown };
      expect(problem.title).toBe('Invalid request body');
      expect(problem.errors).toBeDefined();
    });
  });

  it('validates path parameters and returns 400 on a bad value', async () => {
    const route: RouteDefinition = {
      id: 'getEvent',
      method: 'GET',
      path: '/events/{id}',
      bodyMode: 'none',
      pathSchema: z.object({ id: z.uuid() }),
    };
    const listener = createRequestListener(
      { getEvent: () => Promise.resolve<HandledResponse>({ status: 200, body: {} }) },
      [route],
    );

    await withServer(listener, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/events/not-a-uuid`);
      expect(res.status).toBe(400);
    });
  });

  it('returns a discriminated-union-shaped response for a documented error status', async () => {
    const route: RouteDefinition = {
      id: 'getWidget',
      method: 'GET',
      path: '/widgets/{id}',
      bodyMode: 'none',
      responseSchemas: {
        200: z.object({ id: z.string(), name: z.string() }),
        404: z.object({ message: z.string() }),
      },
    };
    const listener = createRequestListener(
      {
        getWidget: (request: { path: { id: string } }) =>
          Promise.resolve<HandledResponse>(
            request.path.id === 'missing'
              ? { status: 404, body: { message: 'not found' } }
              : { status: 200, body: { id: request.path.id, name: 'Widget' } },
          ),
      },
      [route],
    );

    await withServer(listener, async (baseUrl) => {
      const ok = await fetch(`${baseUrl}/widgets/1`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ id: '1', name: 'Widget' });

      const missing = await fetch(`${baseUrl}/widgets/missing`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ message: 'not found' });
    });
  });

  it('rejects a handler response that fails its own response schema, in validating mode', async () => {
    const route: RouteDefinition = {
      id: 'getWidget',
      method: 'GET',
      path: '/widgets/{id}',
      bodyMode: 'none',
      responseSchemas: { 200: z.object({ id: z.string(), name: z.string() }) },
    };
    const errors: unknown[] = [];
    const listener = createRequestListener(
      { getWidget: () => Promise.resolve<HandledResponse>({ status: 200, body: { id: '1' } }) },
      [route],
      { onError: (error) => errors.push(error) },
    );

    await withServer(listener, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/widgets/1`);
      expect(res.status).toBe(500);
      expect(errors).toHaveLength(1);
    });
  });

  it('passes an octet-stream body through as the unconsumed request, never buffering it', async () => {
    const seenBeforeHandle: (Buffer | undefined)[] = [];
    const route: RouteDefinition = {
      id: 'uploadBlob',
      method: 'POST',
      path: '/uploads',
      bodyMode: 'octet-stream',
      // hey-api's zod plugin preserves the spec's declared header casing
      // ('X-Signature'), while Node always lowercases incoming header
      // names — this schema's mixed case is deliberate, to prove the
      // adapter reconciles the two rather than requiring lowercase specs.
      headersSchema: z.object({ 'X-Signature': z.string() }),
    };
    const listener = createRequestListener(
      {
        uploadBlob: async (request: { body: NodeJS.ReadableStream }) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request.body) {
            chunks.push(chunk as Buffer);
          }
          return { status: 201, body: { bytes: Buffer.concat(chunks).length } };
        },
      },
      [route],
      { beforeHandle: (_req, _route, rawBody) => void seenBeforeHandle.push(rawBody) },
    );

    await withServer(listener, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/uploads`, {
        method: 'POST',
        headers: { 'x-signature': 'abc', 'content-type': 'application/octet-stream' },
        body: new Uint8Array([1, 2, 3, 4]),
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ bytes: 4 });
      expect(seenBeforeHandle).toEqual([undefined]);
    });
  });

  it('rejects a JSON body over maxJsonBodyBytes with 413, without buffering past the cap', async () => {
    const route: RouteDefinition = {
      id: 'createPet',
      method: 'POST',
      path: '/pets',
      bodyMode: 'json',
      bodySchema: z.object({ name: z.string() }),
    };
    let handlerCalled = false;
    const listener = createRequestListener(
      {
        createPet: () => {
          handlerCalled = true;
          return Promise.resolve<HandledResponse>({ status: 201, body: {} });
        },
      },
      [route],
      { maxJsonBodyBytes: 8 },
    );

    await withServer(listener, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/pets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 9 raw bytes, one over the 8-byte cap.
        body: '{"n":123}',
      });
      expect(res.status).toBe(413);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      const problem = (await res.json()) as { title: string; status: number };
      expect(problem).toEqual({ title: 'Payload Too Large', status: 413 });
    });
    expect(handlerCalled).toBe(false);
  });

  it('accepts a JSON body exactly at maxJsonBodyBytes', async () => {
    const route: RouteDefinition = {
      id: 'createPet',
      method: 'POST',
      path: '/pets',
      bodyMode: 'json',
      bodySchema: z.object({ name: z.string() }),
    };
    const body = JSON.stringify({ name: 'x' });
    const listener = createRequestListener(
      { createPet: () => Promise.resolve<HandledResponse>({ status: 201, body: {} }) },
      [route],
      { maxJsonBodyBytes: Buffer.byteLength(body) },
    );

    await withServer(listener, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/pets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(res.status).toBe(201);
    });
  });

  it('defaults maxJsonBodyBytes to 1 MiB, accepting a body just under it', async () => {
    const route: RouteDefinition = {
      id: 'createPet',
      method: 'POST',
      path: '/pets',
      bodyMode: 'json',
    };
    const listener = createRequestListener(
      { createPet: () => Promise.resolve<HandledResponse>({ status: 201, body: {} }) },
      [route],
    );
    const body = JSON.stringify({ name: 'x'.repeat(1024 * 1024 - 100) });

    await withServer(listener, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/pets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(res.status).toBe(201);
    });
  });

  it('exposes the raw JSON body bytes to beforeHandle before parsing', async () => {
    const seen: string[] = [];
    const route: RouteDefinition = {
      id: 'createPet',
      method: 'POST',
      path: '/pets',
      bodyMode: 'json',
    };
    const listener = createRequestListener(
      { createPet: () => Promise.resolve<HandledResponse>({ status: 201, body: {} }) },
      [route],
      { beforeHandle: (_req, _route, rawBody) => void seen.push(rawBody?.toString('utf8') ?? '') },
    );

    await withServer(listener, async (baseUrl) => {
      await fetch(`${baseUrl}/pets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"Rex"}',
      });
      expect(seen).toEqual(['{"name":"Rex"}']);
    });
  });

  it('runs beforeHandle before path/query/header parsing, not just before the body', async () => {
    const seen: string[] = [];
    const route: RouteDefinition = {
      id: 'getWidget',
      method: 'GET',
      path: '/widgets/{id}',
      bodyMode: 'none',
      // "not-a-real-id" fails this schema. If beforeHandle ran after path
      // parsing (as it used to for every route, not only a body-bearing
      // one), the adapter would already have sent 400 and returned before
      // ever reaching beforeHandle -- it would never run at all for this
      // request.
      pathSchema: z.object({ id: z.enum(['1', '2', '3']) }),
    };
    const listener = createRequestListener(
      { getWidget: () => Promise.resolve<HandledResponse>({ status: 200, body: {} }) },
      [route],
      { beforeHandle: (_req, matchedRoute) => void seen.push(matchedRoute.id) },
    );

    await withServer(listener, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/widgets/not-a-real-id`);
      expect(res.status).toBe(400);
      expect(seen).toEqual(['getWidget']);
    });
  });

  describe('hostile request paths', () => {
    const slotRoute: RouteDefinition = {
      id: 'resetSlot',
      method: 'POST',
      path: '/slots/{id}/reset',
      bodyMode: 'none',
      pathSchema: z.object({ id: z.string() }),
    };
    const listener = createRequestListener(
      {
        resetSlot: (request: { path: { id: string } }) =>
          Promise.resolve<HandledResponse>({ status: 200, body: { id: request.path.id } }),
      },
      [slotRoute],
    );

    it.each([
      ['an empty segment that drops the count', '/slots//reset'],
      ['an empty segment that keeps the count', '/slots//abc/reset'],
      ['a double slash before the last segment', '/slots/abc//reset'],
      ['a leading double slash', '//slots/abc/reset'],
      ['a bare double-slash target', '//'],
      ['a triple-slash target', '///'],
      ['a leading double slash before a bracket', '//[/'],
      ['a leading double slash before an at-sign', '//@/'],
      ['a leading double slash before an invalid port', '//a:99999/slots/abc/reset'],
      ['a leading double slash before a bad escape', '//%zz/reset'],
      ['a leading double slash naming a host', '//localhost/slots/abc/reset'],
      ['a trailing slash', '/slots/abc/reset/'],
      ['a bare percent sign', '/slots/%/reset'],
      ['a non-hex escape', '/slots/%zz/reset'],
      ['a truncated multi-byte escape', '/slots/%E0%A4%A/reset'],
      ['an encoded slash in a parameter', '/slots/a%2Fb/reset'],
    ])('answers 404, never 500 or a match, for %s (%s)', async (_label, path) => {
      await withServer(listener, async (baseUrl) => {
        const res = await fetch(`${baseUrl}${path}`, { method: 'POST' });
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
      });
    });

    // fetch normalises dot-segments before sending, so these send raw bytes.
    it.each([
      ['an escaped double dot as a parameter', '/slots/%2e%2e/reset'],
      ['an escaped single dot as a parameter', '/slots/%2e/reset'],
    ])('answers 404 for %s (%s), never a dot-segment id', async (_label, path) => {
      await withServer(listener, async (baseUrl) => {
        const { hostname, port } = new URL(baseUrl);
        const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
          const req = http.request({ hostname, port, path, method: 'POST' }, resolve);
          req.on('error', reject);
          req.end();
        });
        res.resume();
        expect(res.statusCode).toBe(404);
        expect(res.headers['content-type']).toBe('application/problem+json');
      });
    });

    it('still matches a clean path (control case)', async () => {
      await withServer(listener, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/slots/abc/reset`, { method: 'POST' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: 'abc' });
      });
    });

    it('decodes an ordinary percent-escape in a parameter (control case)', async () => {
      await withServer(listener, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/slots/a%20b/reset`, { method: 'POST' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: 'a b' });
      });
    });
  });
});

describe('beforeHandle refusals', () => {
  const route: RouteDefinition = {
    id: 'createPet',
    method: 'POST',
    path: '/pets',
    bodyMode: 'json',
    bodySchema: z.object({ name: z.string() }),
  };

  it.each([
    { status: 401, body: { title: 'Unauthorized', status: 401 } },
    { status: 404, body: { title: 'Not Found', status: 404 } },
  ])(
    'returns the refused status $status and body exactly as beforeHandle gave them',
    async (refusal) => {
      let handlerCalled = false;
      const listener = createRequestListener(
        {
          createPet: () => {
            handlerCalled = true;
            return Promise.resolve<HandledResponse>({ status: 201, body: {} });
          },
        },
        [route],
        { beforeHandle: () => refusal },
      );

      await withServer(listener, async (baseUrl) => {
        // The body is invalid on purpose: a request that got past beforeHandle
        // would answer 400, so a 401/404 here proves the refusal ran first.
        const res = await fetch(`${baseUrl}/pets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 42 }),
        });
        expect(res.status).toBe(refusal.status);
        expect(await res.json()).toEqual(refusal.body);
      });
      expect(handlerCalled).toBe(false);
    },
  );

  it('returns a refused 413 with an empty body when the refusal carries none', async () => {
    let handlerCalled = false;
    const listener = createRequestListener(
      {
        createPet: () => {
          handlerCalled = true;
          return Promise.resolve<HandledResponse>({ status: 201, body: {} });
        },
      },
      [route],
      { beforeHandle: () => ({ status: 413 }) },
    );

    await withServer(listener, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/pets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Rex' }),
      });
      expect(res.status).toBe(413);
      expect(await res.text()).toBe('');
    });
    expect(handlerCalled).toBe(false);
  });

  it('sends a refusal status and headers when beforeHandle is async', async () => {
    const listener = createRequestListener(
      { createPet: () => Promise.resolve<HandledResponse>({ status: 201, body: {} }) },
      [route],
      {
        beforeHandle: async () => {
          await Promise.resolve();
          return { status: 401, headers: { 'www-authenticate': 'Speckify-Signature' } };
        },
      },
    );

    await withServer(listener, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/pets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Rex' }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Speckify-Signature');
    });
  });

  it('still answers 500 when beforeHandle throws (control: a throw is not a refusal)', async () => {
    let handlerCalled = false;
    const errors: unknown[] = [];
    const listener = createRequestListener(
      {
        createPet: () => {
          handlerCalled = true;
          return Promise.resolve<HandledResponse>({ status: 201, body: {} });
        },
      },
      [route],
      {
        beforeHandle: () => {
          throw new Error('verifier crashed');
        },
        onError: (error) => void errors.push(error),
      },
    );

    await withServer(listener, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/pets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Rex' }),
      });
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
    });
    expect(handlerCalled).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it('types beforeHandle as returning a refusal, or nothing to continue', () => {
    type Hook = NonNullable<ListenerOptions['beforeHandle']>;
    /* eslint-disable @typescript-eslint/no-invalid-void-type -- the hook may return void, which is the type under test */
    expectTypeOf<ReturnType<Hook>>().toEqualTypeOf<
      void | HandledResponse | Promise<void | HandledResponse>
    >();
    /* eslint-enable @typescript-eslint/no-invalid-void-type */
  });
});

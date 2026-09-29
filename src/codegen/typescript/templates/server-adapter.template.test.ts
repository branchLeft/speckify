import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  createRequestListener,
  type HandledResponse,
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
      pathSchema: z.object({ id: z.string().uuid() }),
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
      headersSchema: z.object({ 'x-signature': z.string() }),
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
});

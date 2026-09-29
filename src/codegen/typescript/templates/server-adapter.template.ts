/**
 * Speckify's node:http server adapter. This file is copied verbatim into
 * every generated server package (see ../server/write-server.ts) so that
 * package has no runtime dependency on Speckify itself — only on zod, which
 * it already depends on for its own generated schemas. It is typechecked
 * and unit-tested here, in the tool repo, so a defect is caught long before
 * it is baked into a producer's published package.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z, type ZodType } from 'zod';

export interface RequestContext {
  readonly rawRequest: IncomingMessage;
}

export interface HandledResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** The shape every generated per-operation Handlers method request takes. */
export interface HandlerRequest<Path, Query, Headers, Body> {
  readonly path: Path;
  readonly query: Query;
  readonly headers: Headers;
  readonly body: Body;
}

/**
 * A discriminated union over a Responses map's own keys, e.g.
 * `{ 200: Thing; 404: Problem }` becomes
 * `{ status: 200; body: Thing } | { status: 404; body: Problem }`.
 */
export type HandlerResponse<Responses extends Record<number, unknown>> = {
  [Status in keyof Responses]: Status extends number
    ? { status: Status; body: Responses[Status]; headers?: Record<string, string> }
    : never;
}[keyof Responses];

type AnyHandler = (
  request: { path: unknown; query: unknown; headers: unknown; body: unknown },
  context: RequestContext,
) => Promise<HandledResponse>;

export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'PATCH';

export interface RouteDefinition {
  /** The Handlers method this route dispatches to; matches an operationId. */
  readonly id: string;
  readonly method: HttpMethod;
  /** An OpenAPI-style path template, e.g. `/things/{id}`. */
  readonly path: string;
  readonly bodyMode: 'json' | 'octet-stream' | 'none';
  readonly pathSchema?: ZodType;
  readonly querySchema?: ZodType;
  readonly headersSchema?: ZodType;
  readonly bodySchema?: ZodType;
  /** Response validators, keyed by status; a status without one is not checked. */
  readonly responseSchemas?: Readonly<Record<number, ZodType>>;
}

export interface ListenerOptions {
  /** Validate handler responses against `responseSchemas`. @default true */
  readonly validateResponses?: boolean;
  /**
   * Runs before body parsing, for callers that need to verify a request
   * signature from headers. `rawBody` carries the exact bytes for a JSON
   * body (signing covers the raw body, not the parsed value); it is
   * `undefined` for an octet-stream body, which is never buffered here.
   */
  readonly beforeHandle?: (
    rawRequest: IncomingMessage,
    route: RouteDefinition,
    rawBody: Buffer | undefined,
  ) => void | Promise<void>;
  readonly onError?: (error: unknown, rawRequest: IncomingMessage) => void;
}

interface ProblemJson {
  readonly title: string;
  readonly status: number;
  readonly errors?: unknown;
}

function sendProblem(res: ServerResponse, status: number, title: string, errors?: unknown): void {
  const body: ProblemJson = errors === undefined ? { title, status } : { title, status, errors };
  res.writeHead(status, { 'content-type': 'application/problem+json' });
  res.end(JSON.stringify(body));
}

/**
 * Matches a request path against an OpenAPI-style template and returns the
 * captured path parameters, or `undefined` when the segment counts or
 * literal segments don't line up.
 */
function matchPath(template: string, actual: string): Record<string, string> | undefined {
  const templateParts = template.split('/').filter((part) => part.length > 0);
  const actualParts = actual.split('/').filter((part) => part.length > 0);
  if (templateParts.length !== actualParts.length) return undefined;

  const params: Record<string, string> = {};
  for (let i = 0; i < templateParts.length; i += 1) {
    const templatePart = templateParts[i] ?? '';
    const actualPart = actualParts[i] ?? '';
    if (templatePart.startsWith('{') && templatePart.endsWith('}')) {
      params[templatePart.slice(1, -1)] = decodeURIComponent(actualPart);
    } else if (templatePart !== actualPart) {
      return undefined;
    }
  }
  return params;
}

function readJsonBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function headersToRecord(req: IncomingMessage): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') record[key] = value;
    else if (Array.isArray(value)) record[key] = value.join(', ');
  }
  return record;
}

/**
 * Node always lowercases incoming header names, but a header schema's keys
 * are whatever case the spec declared (hey-api's zod plugin preserves it
 * verbatim). Headers are case-insensitive per RFC 9110, so the schema's own
 * declared keys are lowercased to match before validating against `req.headers`.
 */
function withLowercasedHeaderKeys(schema: ZodType): ZodType {
  const shape = (schema as unknown as { shape?: Record<string, ZodType> }).shape;
  if (!shape) return schema;
  return z.object(
    Object.fromEntries(Object.entries(shape).map(([key, value]) => [key.toLowerCase(), value])),
  );
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: object,
  routes: readonly RouteDefinition[],
  validateResponses: boolean,
  options: ListenerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = (req.method ?? 'GET').toUpperCase();

  const route = routes.find(
    (candidate) => candidate.method === method && matchPath(candidate.path, url.pathname),
  );
  if (!route) {
    sendProblem(res, 404, 'Not Found');
    return;
  }
  const pathParams = matchPath(route.path, url.pathname) ?? {};

  if (route.pathSchema) {
    const result = route.pathSchema.safeParse(pathParams);
    if (!result.success) {
      sendProblem(res, 400, 'Invalid path parameters', result.error.issues);
      return;
    }
  }

  const query = Object.fromEntries(url.searchParams.entries());
  if (route.querySchema) {
    const result = route.querySchema.safeParse(query);
    if (!result.success) {
      sendProblem(res, 400, 'Invalid query parameters', result.error.issues);
      return;
    }
  }

  const headers = headersToRecord(req);
  if (route.headersSchema) {
    const result = withLowercasedHeaderKeys(route.headersSchema).safeParse(headers);
    if (!result.success) {
      sendProblem(res, 400, 'Invalid headers', result.error.issues);
      return;
    }
  }

  let body: unknown;
  if (route.bodyMode === 'octet-stream') {
    await options.beforeHandle?.(req, route, undefined);
    body = req;
  } else if (route.bodyMode === 'json') {
    const raw = await readJsonBody(req);
    await options.beforeHandle?.(req, route, raw);
    if (raw.length === 0) {
      body = undefined;
    } else {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendProblem(res, 400, 'Malformed JSON body');
        return;
      }
    }
    if (route.bodySchema) {
      const result = route.bodySchema.safeParse(body);
      if (!result.success) {
        sendProblem(res, 400, 'Invalid request body', result.error.issues);
        return;
      }
      body = result.data;
    }
  } else {
    await options.beforeHandle?.(req, route, undefined);
    body = undefined;
  }

  // The concrete per-package `Handlers` interface types each method
  // precisely; this generic dispatcher only ever sees it structurally, so
  // the lookup is cast once at this one boundary rather than threading an
  // unsound generic through the public signature.
  const handler = (handlers as Record<string, AnyHandler>)[route.id];
  if (!handler) {
    // A route without a matching handler means generation produced an
    // inconsistent package (the completeness guard should have caught this
    // first); fail loudly rather than serve a silent 404 for a documented
    // operation.
    throw new Error(`No handler registered for operation "${route.id}"`);
  }

  const response = await handler({ path: pathParams, query, headers, body }, { rawRequest: req });

  if (validateResponses) {
    const schema = route.responseSchemas?.[response.status];
    if (schema) {
      const result = schema.safeParse(response.body);
      if (!result.success) {
        throw new Error(
          `Handler for "${route.id}" returned a status ${String(response.status)} body that fails its schema: ${result.error.message}`,
        );
      }
    }
  }

  res.writeHead(response.status, { 'content-type': 'application/json', ...response.headers });
  res.end(response.body === undefined ? undefined : JSON.stringify(response.body));
}

/**
 * Builds a `node:http` request listener that dispatches to `handlers` by
 * matching `routes`. `Handlers` is typed loosely here (each method takes an
 * untyped request) so this stays generic; the package's own generated
 * `Handlers` interface is what gives a consumer full type safety when it
 * implements the interface.
 */
export function createRequestListener(
  handlers: object,
  routes: readonly RouteDefinition[],
  options: ListenerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const validateResponses = options.validateResponses ?? true;
  return (req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, handlers, routes, validateResponses, options).catch(
      (error: unknown) => {
        options.onError?.(error, req);
        if (!res.headersSent) {
          sendProblem(res, 500, 'Internal Server Error');
        }
      },
    );
  };
}

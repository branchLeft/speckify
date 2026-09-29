import { describe, expect, it } from 'vitest';
import { CodegenInputError } from './errors.js';
import { extractOperations } from './operations.js';

describe('extractOperations', () => {
  it('extracts method, path and error/body flags per operation', () => {
    const ops = extractOperations({
      paths: {
        '/things/{id}': {
          get: {
            operationId: 'getThing',
            responses: { '200': {}, '404': {} },
          },
        },
        '/uploads': {
          post: {
            operationId: 'uploadBlob',
            requestBody: { content: { 'application/octet-stream': {} } },
            responses: { '201': {} },
          },
        },
      },
    });

    expect(ops).toEqual([
      {
        operationId: 'getThing',
        method: 'get',
        path: '/things/{id}',
        hasDocumentedErrors: true,
        isOctetStreamBody: false,
        hasRequestBody: false,
        hasPathParams: false,
        hasQueryParams: false,
        hasHeaderParams: false,
      },
      {
        operationId: 'uploadBlob',
        method: 'post',
        path: '/uploads',
        hasDocumentedErrors: false,
        isOctetStreamBody: true,
        hasRequestBody: true,
        hasPathParams: false,
        hasQueryParams: false,
        hasHeaderParams: false,
      },
    ]);
  });

  it('records the sole 2xx status that has a content schema as successStatus', () => {
    const [op] = extractOperations({
      paths: {
        '/things/{id}': {
          get: {
            operationId: 'getThing',
            parameters: [
              { name: 'id', in: 'path' },
              { name: 'q', in: 'query' },
              { name: 'X-Trace', in: 'header' },
            ],
            responses: {
              '200': { content: { 'application/json': {} } },
              '404': {},
            },
          },
        },
      },
    });

    expect(op?.successStatus).toBe(200);
    expect(op?.hasPathParams).toBe(true);
    expect(op?.hasQueryParams).toBe(true);
    expect(op?.hasHeaderParams).toBe(true);
  });

  it('leaves successStatus undefined when the 2xx response has no content', () => {
    const [op] = extractOperations({
      paths: { '/pets': { post: { operationId: 'createPet', responses: { '204': {} } } } },
    });

    expect(op?.successStatus).toBeUndefined();
  });

  it('treats a request body with a json content type as non-octet-stream', () => {
    const [op] = extractOperations({
      paths: {
        '/pets': {
          post: {
            operationId: 'createPet',
            requestBody: { content: { 'application/json': {} } },
            responses: { '201': {} },
          },
        },
      },
    });

    expect(op?.isOctetStreamBody).toBe(false);
    expect(op?.hasRequestBody).toBe(true);
  });

  it('ignores path-item keys that are not HTTP methods', () => {
    const ops = extractOperations({
      paths: {
        '/things': {
          parameters: { notAMethod: true },
          get: { operationId: 'listThings', responses: { '200': {} } },
        },
      },
    });

    expect(ops).toHaveLength(1);
    expect(ops[0]?.operationId).toBe('listThings');
  });

  it('rejects an operation with no operationId', () => {
    expect(() =>
      extractOperations({
        paths: { '/things': { get: { responses: { '200': {} } } } },
      }),
    ).toThrow(CodegenInputError);
  });

  it('returns an empty array for a spec with no paths', () => {
    expect(extractOperations({})).toEqual([]);
  });
});

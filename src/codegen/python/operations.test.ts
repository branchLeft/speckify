import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { extractOperations } from './operations.js';
import type { OperationInfo } from './types.js';

const fixturePath = fileURLToPath(new URL('./fixtures/combined.bundled.yaml', import.meta.url));
const document: unknown = parse(readFileSync(fixturePath, 'utf8'));

function findOperation(operations: readonly OperationInfo[], operationId: string): OperationInfo {
  const found = operations.find((o) => o.operationId === operationId);
  if (!found) {
    throw new Error(`fixture is missing operationId "${operationId}"`);
  }
  return found;
}

describe('extractOperations', () => {
  const operations = extractOperations(document);

  it('finds every operationId in the fixture', () => {
    expect(operations.map((o) => o.operationId).sort()).toEqual(
      [
        'createPet',
        'getAccount',
        'getConfig',
        'getEvent',
        'getNote',
        'getThing',
        'getVersion',
        'uploadBlob',
      ].sort(),
    );
  });

  it('extracts path params', () => {
    const getThing = findOperation(operations, 'getThing');
    expect(getThing.method).toBe('GET');
    expect(getThing.path).toBe('/things/{id}');
    expect(getThing.pathParams).toEqual([
      { name: 'id', pyName: 'id', required: true, pyType: 'str', isArray: false, constraints: {} },
    ]);
  });

  it('extracts a JSON request body ref as a model name', () => {
    const createPet = findOperation(operations, 'createPet');
    expect(createPet.requestBody).toEqual({ kind: 'json', required: true, model: 'Pet' });
    expect(createPet.responses).toContainEqual({ statusCode: '201', model: 'Pet' });
  });

  it('extracts an octet-stream request body and its header params', () => {
    const uploadBlob = findOperation(operations, 'uploadBlob');
    expect(uploadBlob.requestBody).toEqual({ kind: 'octet-stream', required: true });
    expect(uploadBlob.headerParams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'X-Signature',
          pyName: 'signature',
          required: true,
          pyType: 'str',
        }),
        expect.objectContaining({
          name: 'X-Timestamp',
          pyName: 'timestamp',
          required: true,
          pyType: 'str',
        }),
      ]),
    );
  });

  it('returns an empty list for a document with no paths', () => {
    expect(extractOperations({})).toEqual([]);
  });
});

describe('extractOperations (N4: param constraints, array query params, inline bodies)', () => {
  it('carries enum/range/pattern constraints from a query parameter schema', () => {
    const document = {
      paths: {
        '/widgets': {
          get: {
            operationId: 'listWidgets',
            parameters: [
              {
                name: 'status',
                in: 'query',
                required: false,
                schema: { type: 'string', enum: ['active', 'archived'] },
              },
              {
                name: 'limit',
                in: 'query',
                required: false,
                schema: { type: 'integer', minimum: 1, maximum: 100 },
              },
              {
                name: 'slug',
                in: 'query',
                required: false,
                schema: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z-]+$' },
              },
            ],
          },
        },
      },
    };

    const [op] = extractOperations(document);
    expect(op?.queryParams).toEqual([
      {
        name: 'status',
        pyName: 'status',
        required: false,
        pyType: 'str',
        isArray: false,
        constraints: { enum: ['active', 'archived'] },
      },
      {
        name: 'limit',
        pyName: 'limit',
        required: false,
        pyType: 'int',
        isArray: false,
        constraints: { minimum: 1, maximum: 100 },
      },
      {
        name: 'slug',
        pyName: 'slug',
        required: false,
        pyType: 'str',
        isArray: false,
        constraints: { minLength: 1, maxLength: 40, pattern: '^[a-z-]+$' },
      },
    ]);
  });

  it('marks an array-typed query parameter and derives pyType/constraints from its items schema', () => {
    const document = {
      paths: {
        '/widgets': {
          get: {
            operationId: 'listWidgets',
            parameters: [
              {
                name: 'tag',
                in: 'query',
                required: false,
                schema: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
              },
            ],
          },
        },
      },
    };

    const [op] = extractOperations(document);
    expect(op?.queryParams).toEqual([
      {
        name: 'tag',
        pyName: 'tag',
        required: false,
        pyType: 'str',
        isArray: true,
        constraints: { enum: ['a', 'b'] },
      },
    ]);
  });

  it('reports an inline (non-$ref) JSON request body as kind "json" with a null model, never "none"', () => {
    const document = {
      paths: {
        '/widgets': {
          post: {
            operationId: 'createWidget',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { name: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
    };

    const [op] = extractOperations(document);
    expect(op?.requestBody).toEqual({ kind: 'json', required: true, model: null });
  });
});

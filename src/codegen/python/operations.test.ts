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
    expect(getThing.pathParams).toEqual([{ name: 'id', pyName: 'id', required: true, pyType: 'str' }]);
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
        expect.objectContaining({ name: 'X-Signature', pyName: 'signature', required: true, pyType: 'str' }),
        expect.objectContaining({ name: 'X-Timestamp', pyName: 'timestamp', required: true, pyType: 'str' }),
      ]),
    );
  });

  it('returns an empty list for a document with no paths', () => {
    expect(extractOperations({})).toEqual([]);
  });
});

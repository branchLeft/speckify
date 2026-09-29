import { describe, expect, it } from 'vitest';
import { generateHandlersSource } from './generate-handlers.js';
import type { OperationInfo } from '../operations.js';

function op(overrides: Partial<OperationInfo> & Pick<OperationInfo, 'operationId'>): OperationInfo {
  return {
    method: 'get',
    path: '/x',
    hasDocumentedErrors: false,
    isOctetStreamBody: false,
    hasRequestBody: false,
    hasPathParams: false,
    hasQueryParams: false,
    hasHeaderParams: false,
    ...overrides,
  };
}

describe('generateHandlersSource', () => {
  it('emits one method per operation, typed against hey-api Data/Responses types', () => {
    const source = generateHandlersSource([
      op({ operationId: 'getThing', hasPathParams: true, successStatus: 200 }),
    ]);

    expect(source).toContain(
      "import type { GetThingData, GetThingResponses } from './types.gen.js';",
    );
    expect(source).toContain('export interface Handlers {');
    expect(source).toContain(
      "getThing(\n    request: HandlerRequest<GetThingData['path'], undefined, undefined, undefined>,",
    );
    expect(source).toContain('Promise<HandlerResponse<GetThingResponses>>');
  });

  it('merges Errors into the response union when the spec documents a non-2xx status', () => {
    const source = generateHandlersSource([
      op({ operationId: 'getThing', hasDocumentedErrors: true }),
    ]);
    expect(source).toContain('Promise<HandlerResponse<GetThingResponses & GetThingErrors>>');
    expect(source).toContain('GetThingErrors');
  });

  it('types an octet-stream body as a Readable, imported from node:stream', () => {
    const source = generateHandlersSource([
      op({
        operationId: 'uploadBlob',
        isOctetStreamBody: true,
        hasRequestBody: true,
        hasHeaderParams: true,
      }),
    ]);
    expect(source).toContain("import type { Readable } from 'node:stream';");
    expect(source).toContain('Readable>');
  });

  it('types a json request body from the Data type, not a re-invented shape', () => {
    const source = generateHandlersSource([op({ operationId: 'createPet', hasRequestBody: true })]);
    expect(source).toContain("CreatePetData['body']>");
  });

  it('produces a Handlers interface with no methods for an empty spec', () => {
    const source = generateHandlersSource([]);
    expect(source).toContain('export interface Handlers {\n\n}');
  });
});

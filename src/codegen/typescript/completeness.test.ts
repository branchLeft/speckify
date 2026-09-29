import { describe, expect, it } from 'vitest';
import { assertGenerationComplete } from './completeness.js';
import { IncompleteGenerationError } from './errors.js';
import type { OperationInfo } from './operations.js';

function op(operationId: string): OperationInfo {
  return {
    operationId,
    method: 'get',
    path: '/x',
    hasDocumentedErrors: false,
    isOctetStreamBody: false,
    hasRequestBody: false,
    hasPathParams: false,
    hasQueryParams: false,
    hasHeaderParams: false,
  };
}

describe('assertGenerationComplete', () => {
  it('passes when every operation has an SDK function', () => {
    expect(() => {
      assertGenerationComplete([op('getThing'), op('createPet')], {
        sdkFunctionNames: new Set(['getThing', 'createPet']),
      });
    }).not.toThrow();
  });

  it('throws naming the missing operation when the SDK drops one (sabotage)', () => {
    try {
      assertGenerationComplete([op('getThing'), op('createPet')], {
        sdkFunctionNames: new Set(['getThing']),
      });
      expect.fail('expected assertGenerationComplete to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IncompleteGenerationError);
      expect((error as IncompleteGenerationError).missingOperationIds).toEqual(['createPet']);
      expect((error as Error).message).toContain('createPet');
    }
  });

  it('also checks handler method names when a server is requested', () => {
    expect(() => {
      assertGenerationComplete([op('getThing')], {
        sdkFunctionNames: new Set(['getThing']),
        handlerMethodNames: new Set(),
      });
    }).toThrow(IncompleteGenerationError);
  });

  it('does not check handler names when no server was requested', () => {
    expect(() => {
      assertGenerationComplete([op('getThing')], {
        sdkFunctionNames: new Set(['getThing']),
      });
    }).not.toThrow();
  });
});

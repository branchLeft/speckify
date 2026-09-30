import { describe, expect, it } from 'vitest';
import { generateRoutesSource } from './generate-routes.js';
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

describe('generateRoutesSource', () => {
  it('emits a route with method, path and bodyMode for a plain GET', () => {
    const source = generateRoutesSource([
      op({ operationId: 'getThing', path: '/things/{id}', hasPathParams: true }),
    ]);
    expect(source).toContain("id: 'getThing'");
    expect(source).toContain("method: 'GET'");
    expect(source).toContain("path: '/things/{id}'");
    expect(source).toContain("bodyMode: 'none'");
    expect(source).toContain('pathSchema: zGetThingPath');
    expect(source).toContain("import { zGetThingPath } from './zod.gen.js';");
  });

  it('wires an octet-stream body to bodyMode without a bodySchema', () => {
    const source = generateRoutesSource([
      op({
        operationId: 'uploadBlob',
        method: 'post',
        isOctetStreamBody: true,
        hasRequestBody: true,
        hasHeaderParams: true,
      }),
    ]);
    expect(source).toContain("bodyMode: 'octet-stream'");
    expect(source).not.toContain('bodySchema');
    expect(source).toContain('headersSchema: zUploadBlobHeaders');
  });

  it('wires a json body to a bodySchema', () => {
    const source = generateRoutesSource([
      op({ operationId: 'createPet', method: 'post', hasRequestBody: true }),
    ]);
    expect(source).toContain("bodyMode: 'json'");
    expect(source).toContain('bodySchema: zCreatePetBody');
  });

  it('includes responseSchemas keyed by the successStatus code', () => {
    const source = generateRoutesSource([op({ operationId: 'getWidget', successStatus: 200 })]);
    expect(source).toContain('responseSchemas: { 200: zGetWidgetResponse }');
  });

  it('omits responseSchemas when there is no documented success content', () => {
    const source = generateRoutesSource([op({ operationId: 'deleteThing', method: 'delete' })]);
    expect(source).not.toContain('responseSchemas');
  });

  // A spec with no `paths` at all (OAS 3.1's webhooks-only shape,
  // webhook-example.yaml in the OAI corpus) reaches this with an empty
  // operations array. The join-then-append-comma construction used to emit
  // `[\n,\n]` unconditionally — a one-element array with a hole, which
  // `tsc` sees as `undefined[]`, not `RouteDefinition[]`. Caught building
  // the corpus (src/e2e/corpus.test.ts).
  it('emits an empty array literal for no operations, not one with a hole', () => {
    const source = generateRoutesSource([]);
    expect(source).toContain('export const routes: RouteDefinition[] = [];');
  });
});

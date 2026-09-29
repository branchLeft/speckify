import { describe, expect, it } from 'vitest';

import { extractOperations } from './operations.js';
import { prepareServerSpec } from './server-spec.js';

type Doc = Record<string, unknown>;

function prepared(doc: Doc): Doc {
  return JSON.parse(prepareServerSpec(JSON.stringify(doc))) as Doc;
}

const inlineBody = {
  required: true,
  content: {
    'application/json': {
      schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    },
  },
};

describe('prepareServerSpec', () => {
  it('hoists an inline JSON body schema into a named model the router validates against', () => {
    const doc = prepared({
      openapi: '3.0.3',
      paths: { '/widgets': { post: { operationId: 'create_widget', requestBody: inlineBody } } },
    });
    const schemas = (doc.components as Doc).schemas as Doc;
    expect(schemas.CreateWidgetRequestBody).toEqual(inlineBody.content['application/json'].schema);
    const [operation] = extractOperations(doc);
    expect(operation?.requestBody).toEqual({
      kind: 'json',
      required: true,
      model: 'CreateWidgetRequestBody',
    });
  });

  it('never reuses the name of an existing model', () => {
    const doc = prepared({
      openapi: '3.0.3',
      components: { schemas: { 'create-widget-request-body': { type: 'string' } } },
      paths: { '/w': { post: { operationId: 'createWidget', requestBody: inlineBody } } },
    });
    const [operation] = extractOperations(doc);
    expect(operation?.requestBody).toMatchObject({ model: 'CreateWidgetRequestBody2' });
  });

  it('resolves a $ref request body before hoisting, without touching the shared component', () => {
    const doc = prepared({
      openapi: '3.0.3',
      components: { requestBodies: { NewWidget: inlineBody } },
      paths: {
        '/w': {
          post: {
            operationId: 'createWidget',
            requestBody: { $ref: '#/components/requestBodies/NewWidget' },
          },
        },
      },
    });
    const [operation] = extractOperations(doc);
    expect(operation?.requestBody).toMatchObject({
      kind: 'json',
      model: 'CreateWidgetRequestBody',
    });
    expect((doc.components as Doc).requestBodies).toEqual({ NewWidget: inlineBody });
  });

  it('leaves a $ref body schema and an octet-stream body as they are', () => {
    const doc = prepared({
      openapi: '3.0.3',
      components: { schemas: { Widget: { type: 'object' } } },
      paths: {
        '/a': {
          post: {
            operationId: 'a',
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } },
            },
          },
        },
        '/b': {
          post: {
            operationId: 'b',
            requestBody: { content: { 'application/octet-stream': {} } },
          },
        },
      },
    });
    expect(Object.keys((doc.components as Doc).schemas as Doc)).toEqual(['Widget']);
    expect(extractOperations(doc).map((op) => op.requestBody.kind)).toEqual([
      'json',
      'octet-stream',
    ]);
  });

  it('merges path-level parameters and resolves $ref parameters, the operation winning', () => {
    const doc = prepared({
      openapi: '3.0.3',
      components: {
        parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } },
      },
      paths: {
        '/w/{id}': {
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'q', in: 'query', schema: { type: 'string' } },
          ],
          get: {
            operationId: 'getWidget',
            parameters: [
              { $ref: '#/components/parameters/Limit' },
              { name: 'q', in: 'query', schema: { type: 'string', maxLength: 3 } },
            ],
          },
        },
      },
    });
    const [operation] = extractOperations(doc);
    expect(operation?.pathParams.map((p) => p.name)).toEqual(['id']);
    expect(operation?.queryParams.map((p) => [p.name, p.constraints])).toEqual([
      ['q', { maxLength: 3 }],
      ['limit', {}],
    ]);
  });

  it('adds no components section when nothing is hoisted', () => {
    const doc = prepared({ openapi: '3.0.3', paths: { '/a': { get: { operationId: 'a' } } } });
    expect(doc.components).toBeUndefined();
  });
});

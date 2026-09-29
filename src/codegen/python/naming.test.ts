import { describe, expect, it } from 'vitest';

import { importNameFor, modelNameFromRef, pythonIdentifier, snakeCase } from './naming.js';

describe('importNameFor', () => {
  it('swaps hyphens for underscores', () => {
    expect(importNameFor('my-service-api')).toBe('my_service_api');
  });

  it('leaves a name with no hyphens unchanged', () => {
    expect(importNameFor('widgets')).toBe('widgets');
  });
});

describe('modelNameFromRef', () => {
  it('takes the last pointer segment of a local ref', () => {
    expect(modelNameFromRef('#/components/schemas/Pet')).toBe('Pet');
  });

  it('PascalCases a snake_case segment', () => {
    expect(modelNameFromRef('#/components/schemas/event_status')).toBe('EventStatus');
  });

  it('strips a file extension from an external ref and PascalCases it', () => {
    expect(modelNameFromRef('thing.schema.json')).toBe('ThingSchema');
  });
});

describe('snakeCase', () => {
  it('converts camelCase to snake_case', () => {
    expect(snakeCase('getThing')).toBe('get_thing');
  });

  it('converts a single lowercase word unchanged', () => {
    expect(snakeCase('upload')).toBe('upload');
  });

  it('handles an already snake_case identifier', () => {
    expect(snakeCase('upload_blob')).toBe('upload_blob');
  });

  // Real openapi-python-client generates `create_thing_2.py` for operationId
  // `createThing2`: a trailing digit is its own word, not glued onto the
  // preceding one. The previous regex-based implementation gave
  // `create_thing2` here, so completeness-guard.ts refused every operationId
  // with a digit as "missing" even though the generator produced it fine.
  it('splits a trailing digit off as its own word, like the real generator', () => {
    expect(snakeCase('createThing2')).toBe('create_thing_2');
  });

  it('treats a leading digit run before a camelCase hump as its own word', () => {
    expect(snakeCase('v2List')).toBe('v_2_list');
  });

  it('splits a digit run in the middle of an identifier', () => {
    expect(snakeCase('getItem10')).toBe('get_item_10');
  });
});

describe('pythonIdentifier', () => {
  it('mirrors plain snake_case when the result needs no reserved-word suffix or prefix', () => {
    expect(pythonIdentifier('createThing2', 'field_')).toBe('create_thing_2');
  });

  it('suffixes a name that collides with a reserved word', () => {
    expect(pythonIdentifier('list', 'field_', new Set(['list']))).toBe('list_');
  });

  it('leaves a non-colliding name alone even with a reserved-word set given', () => {
    expect(pythonIdentifier('widgets', 'field_', new Set(['list']))).toBe('widgets');
  });

  it('prefixes a name that sanitises to nothing usable', () => {
    expect(pythonIdentifier('123', 'field_')).toBe('field_123');
  });

  it('prefixes a name that started with an underscore, itself treated as a delimiter', () => {
    expect(pythonIdentifier('_private', 'field_')).toBe('field_private');
  });
});

import { describe, expect, it } from 'vitest';

import { importNameFor, modelNameFromRef, snakeCase } from './naming.js';

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
});

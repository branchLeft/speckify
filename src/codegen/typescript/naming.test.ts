import { describe, expect, it } from 'vitest';
import { toCamelCase, toPascalCase } from './naming.js';

describe('toPascalCase', () => {
  it('capitalizes a bare camelCase operationId', () => {
    expect(toPascalCase('getThing')).toBe('GetThing');
  });

  it('splits snake_case', () => {
    expect(toPascalCase('get_thing_by_id')).toBe('GetThingById');
  });

  it('splits kebab-case', () => {
    expect(toPascalCase('get-thing-by-id')).toBe('GetThingById');
  });

  it('handles a single word', () => {
    expect(toPascalCase('upload')).toBe('Upload');
  });
});

describe('toCamelCase', () => {
  it('lowercases only the leading character', () => {
    expect(toCamelCase('uploadBlob')).toBe('uploadBlob');
  });

  it('normalises snake_case to camelCase', () => {
    expect(toCamelCase('get_note')).toBe('getNote');
  });
});

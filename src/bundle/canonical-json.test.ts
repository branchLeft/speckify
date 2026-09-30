import { describe, expect, it } from 'vitest';

import { toCanonicalJson } from './canonical-json.js';

describe('toCanonicalJson', () => {
  it('sorts object keys regardless of insertion order', () => {
    const a = toCanonicalJson({ b: 1, a: 2 });
    const b = toCanonicalJson({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
  });

  it('sorts keys recursively inside nested objects', () => {
    const result = toCanonicalJson({ z: { d: 1, c: 2 }, a: 1 });
    expect(result).toBe('{\n  "a": 1,\n  "z": {\n    "c": 2,\n    "d": 1\n  }\n}\n');
  });

  it('preserves array order', () => {
    const result = toCanonicalJson({ list: [3, 1, 2] });
    expect(result).toBe('{\n  "list": [\n    3,\n    1,\n    2\n  ]\n}\n');
  });

  it('sorts keys of objects nested inside arrays', () => {
    const result = toCanonicalJson([{ b: 1, a: 2 }]);
    expect(result).toBe('[\n  {\n    "a": 2,\n    "b": 1\n  }\n]\n');
  });

  it('leaves primitives and null untouched', () => {
    expect(toCanonicalJson('hello')).toBe('"hello"\n');
    expect(toCanonicalJson(null)).toBe('null\n');
    expect(toCanonicalJson(42)).toBe('42\n');
  });
});

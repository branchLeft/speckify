import { describe, expect, it } from 'vitest';

import { LintError, lintBundledSpec, lintDocument } from './index.js';

const validDoc = {
  openapi: '3.0.3',
  info: { title: 'Widgets', version: '0.0.0' },
  paths: {
    '/widgets': { get: { operationId: 'listWidgets' } },
  },
};

describe('lintDocument', () => {
  it('returns no findings for a clean document', () => {
    expect(lintDocument(validDoc)).toEqual([]);
  });

  it('aggregates findings from every rule', () => {
    const doc = {
      openapi: '2.0',
      paths: {
        '/widgets': { get: {} },
      },
    };
    const findings = lintDocument(doc);
    const ruleIds = findings.map((f) => f.ruleId).sort();
    expect(ruleIds).toEqual(['openapi-version', 'operation-id']);
  });
});

describe('lintBundledSpec', () => {
  it('does not throw for a clean bundled spec', () => {
    expect(() => {
      lintBundledSpec(JSON.stringify(validDoc));
    }).not.toThrow();
  });

  it('throws LintError carrying every finding for a broken spec', () => {
    const doc = { openapi: '3.0.3', paths: { '/widgets': { get: {} } } };
    try {
      lintBundledSpec(JSON.stringify(doc));
      expect.fail('expected lintBundledSpec to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LintError);
      const lintError = error as LintError;
      expect(lintError.findings).toEqual([
        {
          ruleId: 'operation-id',
          pointer: '/paths/~1widgets/get',
          message: 'operation has no operationId',
        },
      ]);
      expect(lintError.message).toContain('operation-id');
    }
  });
});

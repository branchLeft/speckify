import { describe, expect, it } from 'vitest';

import { checkOpenApiVersion, RULE_ID } from './openapi-version.js';

describe('checkOpenApiVersion', () => {
  it.each(['3.0.0', '3.0.3', '3.1.0', '3.1.5'])('accepts %s', (version) => {
    expect(checkOpenApiVersion({ openapi: version })).toEqual([]);
  });

  it.each(['2.0', '3.2.0', '4.0.0', 'not-a-version'])('rejects %s', (version) => {
    const findings = checkOpenApiVersion({ openapi: version });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: RULE_ID, pointer: '/openapi' });
  });

  it('rejects a missing openapi field', () => {
    const findings = checkOpenApiVersion({});
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('null');
  });
});

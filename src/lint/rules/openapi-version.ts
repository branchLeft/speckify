import type { LintFinding } from '../types.js';

export const RULE_ID = 'openapi-version';

const SUPPORTED_VERSION = /^3\.[01]\.\d+$/;

interface OpenApiDocLike {
  openapi?: unknown;
}

/**
 * Requires the document to declare `openapi: 3.0.x` or `3.1.x`. Speckify's
 * generators and oasdiff are only validated against those two lines; an
 * older `2.0` (Swagger) doc or a missing field would silently misbehave
 * further down the pipeline instead of failing here, where the cause is
 * obvious.
 */
export function checkOpenApiVersion(doc: OpenApiDocLike): LintFinding[] {
  const version = doc.openapi;
  if (typeof version === 'string' && SUPPORTED_VERSION.test(version)) {
    return [];
  }

  return [
    {
      ruleId: RULE_ID,
      pointer: '/openapi',
      message: `"openapi" must be 3.0.x or 3.1.x, got ${JSON.stringify(version ?? null)}`,
    },
  ];
}

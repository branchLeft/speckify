import { describe, expect, it } from 'vitest';

import type { ContractPlan } from '../plan.js';
import { PR_COMMENT_MARKER, renderPrComment } from './render.js';

function plan(overrides: Partial<ContractPlan> = {}): ContractPlan {
  return {
    contract: 'orders-api',
    previousVersion: '1.0.0',
    version: '1.1.0',
    bump: 'minor',
    unknownRuleIds: [],
    changes: [],
    uncovered: [],
    bundledSpec: '{}',
    ...overrides,
  };
}

describe('renderPrComment', () => {
  it('starts with the hidden marker', () => {
    const body = renderPrComment([plan()]);
    expect(body.startsWith(PR_COMMENT_MARKER)).toBe(true);
  });

  it('renders the proposed bump for each contract', () => {
    const body = renderPrComment([plan(), plan({ contract: 'billing-api', bump: 'major' })]);
    expect(body).toContain('`orders-api`: 1.0.0 → 1.1.0 (minor)');
    expect(body).toContain('`billing-api`: 1.0.0 → 1.1.0 (major)');
  });

  it('renders "(unpublished)" for a contract with no previous version', () => {
    const body = renderPrComment([plan({ previousVersion: null })]);
    expect(body).toContain('(unpublished) → 1.1.0');
  });

  it('renders the changelog for changes present on the plan', () => {
    const body = renderPrComment([
      plan({
        changes: [
          { id: 'request-body-required-enabled', text: 'a field became required', level: 2 },
        ],
      }),
    ]);
    expect(body).toContain('request-body-required-enabled');
    expect(body).toContain('a field became required');
  });

  it('warns about unknown rule ids treated as major', () => {
    const body = renderPrComment([plan({ unknownRuleIds: ['some-new-rule'] })]);
    expect(body).toContain('Unclassified oasdiff rules treated as major');
    expect(body).toContain('some-new-rule');
  });

  it('renders nothing for unknown rules when there are none', () => {
    const body = renderPrComment([plan()]);
    expect(body).not.toContain('Unclassified');
  });

  it('renders a section for every contract, in order, even with none', () => {
    const body = renderPrComment([]);
    expect(body.startsWith(PR_COMMENT_MARKER)).toBe(true);
    expect(body).toContain('## Speckify');
  });
});

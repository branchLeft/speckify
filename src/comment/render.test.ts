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
    judgements: [],
    surface: null,
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

  it('lists the generated-surface changes that break existing clients', () => {
    const body = renderPrComment([
      plan({
        bump: 'major',
        surface: {
          bump: 'major',
          changes: [
            {
              language: 'python',
              symbol: 'pkg.api.alpha',
              bump: 'major',
              reason: 'module removed',
            },
            { language: 'typescript', symbol: '.#Pet2', bump: 'minor', reason: 'export added' },
          ],
          serverChanges: [],
        },
      }),
    ]);
    expect(body).toContain('Generated-surface changes that break existing clients');
    expect(body).toContain('python `pkg.api.alpha`: module removed');
    expect(body).not.toContain('Pet2');
  });

  it('renders no surface section without breaking surface changes', () => {
    expect(renderPrComment([plan()])).not.toContain('Generated-surface');
  });

  it('reports server-only surface changes without them affecting the version', () => {
    const body = renderPrComment([
      plan({
        bump: 'minor',
        surface: {
          bump: 'minor',
          changes: [
            { language: 'python', symbol: 'pkg.models.Pet', bump: 'minor', reason: 'export added' },
          ],
          serverChanges: [
            {
              language: 'python',
              symbol: 'pkg.server.handlers.Handlers',
              bump: 'major',
              reason: 'a Protocol consumers implement changed',
            },
          ],
        },
      }),
    ]);
    expect(body).toContain('Server changes (do not affect this version)');
    expect(body).toContain(
      'python `pkg.server.handlers.Handlers` (major): a Protocol consumers implement changed',
    );
    expect(body).not.toContain('Generated-surface changes that break existing clients');
  });

  it('renders no server-changes section when there are none', () => {
    expect(renderPrComment([plan()])).not.toContain('Server changes');
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

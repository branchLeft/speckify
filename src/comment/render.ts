import { renderChangelogMarkdown } from '../plan.js';
import type { ContractPlan } from '../plan.js';

/**
 * A hidden marker identifying Speckify's own PR comment among all the
 * others a PR collects, so `create-or-update` can find its previous comment
 * instead of piling up a new one on every push.
 */
export const PR_COMMENT_MARKER = '<!-- speckify:pr-comment -->';

function renderContractSection(plan: ContractPlan): string {
  const from = plan.previousVersion ?? '(unpublished)';
  const lines = [`### \`${plan.contract}\`: ${from} → ${plan.version} (${plan.bump})`, ''];

  lines.push(renderChangelogMarkdown(plan.changes).trimEnd(), '');

  if (plan.unknownRuleIds.length > 0) {
    lines.push(
      `> **Unclassified oasdiff rules treated as major:** ${plan.unknownRuleIds.join(', ')}`,
      '',
    );
  }

  const breaking = (plan.surface?.changes ?? []).filter((change) => change.bump === 'major');
  if (breaking.length > 0) {
    lines.push('Generated-surface changes that break existing clients:', '');
    for (const change of breaking) {
      lines.push(`- ${change.language} \`${change.symbol}\`: ${change.reason}`);
    }
    lines.push('');
  }

  const serverChanges = plan.surface?.serverChanges ?? [];
  if (serverChanges.length > 0) {
    // Reported for the producer who regenerates their own server; never
    // part of the bump above (surface.md §1).
    lines.push('Server changes (do not affect this version):', '');
    for (const change of serverChanges) {
      lines.push(`- ${change.language} \`${change.symbol}\` (${change.bump}): ${change.reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Renders the full PR comment body for a `speckify check` run: one section
 * per contract's proposed bump and changelog, grouped in the order the
 * contracts were declared, prefixed with the hidden marker that makes the
 * comment identifiable on a later run.
 */
export function renderPrComment(plans: readonly ContractPlan[]): string {
  const sections = plans.map((plan) => renderContractSection(plan));
  return [
    PR_COMMENT_MARKER,
    '## Speckify',
    '',
    'This PR changes one or more OpenAPI contracts. Here is the version each would publish as, and why.',
    '',
    ...sections,
  ].join('\n');
}

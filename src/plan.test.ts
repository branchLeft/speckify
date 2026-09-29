import { describe, expect, it, vi } from 'vitest';

import { LintError } from './lint/index.js';
import { computeContractPlan, renderChangelogMarkdown } from './plan.js';
import type { OasdiffChange, ProcessRunner } from './oasdiff/index.js';
import type { ClassificationMap } from './version/index.js';

const map: ClassificationMap = {
  'response-required-property-removed': 'major',
  'request-property-added': 'minor',
};

function runProcessReturning(changes: OasdiffChange[]): ProcessRunner {
  return vi.fn(async () => Promise.resolve({ stdout: JSON.stringify(changes), stderr: '' }));
}

const bundledSpecV1 = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Widgets', version: '0.0.0' },
  paths: {},
});

// A real published record's stored spec carries its actual published
// version, never the 0.0.0 placeholder a fresh bundle always uses. Using
// a 0.0.0-versioned fixture as `previous.bundledSpec` (as this file used
// to) hides the version normalisation entirely: the two specs would already
// share the same info.version by accident.
const publishedSpecV1_2_0 = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Widgets', version: '1.2.0' },
  paths: {},
});

describe('computeContractPlan', () => {
  it('fails lint before ever running oasdiff, for a first publish', async () => {
    const runProcess = vi.fn();
    const invalidSpec = JSON.stringify({
      openapi: '2.0',
      info: { title: 'Widgets', version: '0.0.0' },
      paths: {},
    });

    await expect(
      computeContractPlan({
        contract: 'orders-api',
        bundledSpec: invalidSpec,
        previous: null,
        classificationMap: map,
        toolchainImpactBump: 'none',
        oasdiffPath: '/bin/oasdiff',
        runProcess,
      }),
    ).rejects.toThrow(LintError);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('fails lint before diffing against a previous version', async () => {
    const runProcess = vi.fn();
    const invalidSpec = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Widgets', version: '0.0.0' },
      paths: { '/widgets': { get: {} } },
    });

    await expect(
      computeContractPlan({
        contract: 'orders-api',
        bundledSpec: invalidSpec,
        previous: { version: '1.2.0', bundledSpec: publishedSpecV1_2_0, speckifyVersion: null },
        classificationMap: map,
        toolchainImpactBump: 'none',
        oasdiffPath: '/bin/oasdiff',
        runProcess,
      }),
    ).rejects.toThrow(LintError);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('is a first publish when there is no previous record: always 1.0.0, no oasdiff run', async () => {
    const runProcess = vi.fn();
    const plan = await computeContractPlan({
      contract: 'orders-api',
      bundledSpec: bundledSpecV1,
      previous: null,
      classificationMap: map,
      toolchainImpactBump: 'none',
      oasdiffPath: '/bin/oasdiff',
      runProcess,
    });

    expect(plan.previousVersion).toBeNull();
    expect(plan.version).toBe('1.0.0');
    expect(plan.bump).toBe('none');
    expect(plan.changes).toEqual([]);
    expect(runProcess).not.toHaveBeenCalled();

    const stamped = JSON.parse(plan.bundledSpec) as { info: { version: string } };
    expect(stamped.info.version).toBe('1.0.0');
  });

  it('bumps minor for an additive change against a published version', async () => {
    const changes: OasdiffChange[] = [
      { id: 'request-property-added', text: 'added an optional request property', level: 1 },
    ];
    const plan = await computeContractPlan({
      contract: 'orders-api',
      bundledSpec: bundledSpecV1,
      previous: { version: '1.2.0', bundledSpec: publishedSpecV1_2_0, speckifyVersion: null },
      classificationMap: map,
      toolchainImpactBump: 'none',
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning(changes),
    });

    expect(plan.version).toBe('1.3.0');
    expect(plan.bump).toBe('minor');
    expect(plan.unknownRuleIds).toEqual([]);
  });

  it('treats an unmapped rule id as major and reports it', async () => {
    const changes: OasdiffChange[] = [{ id: 'some-new-rule', text: 'something changed', level: 2 }];
    const plan = await computeContractPlan({
      contract: 'orders-api',
      bundledSpec: bundledSpecV1,
      previous: { version: '1.2.0', bundledSpec: publishedSpecV1_2_0, speckifyVersion: null },
      classificationMap: map,
      toolchainImpactBump: 'none',
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning(changes),
    });

    expect(plan.bump).toBe('major');
    expect(plan.unknownRuleIds).toEqual(['some-new-rule']);
  });

  it('bumps patch when the spec text changed but oasdiff reports no semantic change', async () => {
    const revisedSpec = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Widgets API', version: '0.0.0' },
      paths: {},
    });
    const plan = await computeContractPlan({
      contract: 'orders-api',
      bundledSpec: revisedSpec,
      previous: { version: '1.2.0', bundledSpec: publishedSpecV1_2_0, speckifyVersion: null },
      classificationMap: map,
      toolchainImpactBump: 'none',
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning([]),
    });

    expect(plan.bump).toBe('patch');
    expect(plan.version).toBe('1.2.1');
  });

  it('leaves the version unchanged when the spec text and semantics are both unchanged', async () => {
    const plan = await computeContractPlan({
      contract: 'orders-api',
      bundledSpec: bundledSpecV1,
      previous: { version: '1.2.0', bundledSpec: publishedSpecV1_2_0, speckifyVersion: null },
      classificationMap: map,
      toolchainImpactBump: 'none',
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning([]),
    });

    expect(plan.bump).toBe('none');
    expect(plan.version).toBe('1.2.0');
  });

  it('bumps major when oasdiff reports nothing but additionalProperties tightened true→false (fail-safe: oasdiff missed it)', async () => {
    const previousSpec = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Widgets', version: '1.2.0' },
      paths: {
        '/widgets': {
          post: {
            operationId: 'createWidget',
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', additionalProperties: true },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    const currentSpec = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Widgets', version: '0.0.0' },
      paths: {
        '/widgets': {
          post: {
            operationId: 'createWidget',
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', additionalProperties: false },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });

    const plan = await computeContractPlan({
      contract: 'orders-api',
      bundledSpec: currentSpec,
      previous: { version: '1.2.0', bundledSpec: previousSpec, speckifyVersion: null },
      classificationMap: map,
      toolchainImpactBump: 'none',
      oasdiffPath: '/bin/oasdiff',
      // oasdiff missed the tightened schema, as if the binary had a real gap.
      runProcess: runProcessReturning([]),
    });

    expect(plan.bump).toBe('major');
    expect(plan.version).toBe('2.0.0');
  });

  it('bumps major when oasdiff reports nothing but the servers URL changed (fail-safe: oasdiff missed it)', async () => {
    const previousSpec = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Widgets', version: '1.2.0' },
      servers: [{ url: 'https://api.example.com/v1' }],
      paths: {},
    });
    const currentSpec = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Widgets', version: '0.0.0' },
      servers: [{ url: 'https://api.example.com/v2' }],
      paths: {},
    });

    const plan = await computeContractPlan({
      contract: 'orders-api',
      bundledSpec: currentSpec,
      previous: { version: '1.2.0', bundledSpec: previousSpec, speckifyVersion: null },
      classificationMap: map,
      toolchainImpactBump: 'none',
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning([]),
    });

    expect(plan.bump).toBe('major');
    expect(plan.version).toBe('2.0.0');
  });

  it('bumps patch (not major) when the only unreported difference is a description', async () => {
    const previousSpec = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Widgets', version: '1.2.0', description: 'Old description' },
      paths: {},
    });
    const currentSpec = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Widgets', version: '0.0.0', description: 'New, friendlier description' },
      paths: {},
    });

    const plan = await computeContractPlan({
      contract: 'orders-api',
      bundledSpec: currentSpec,
      previous: { version: '1.2.0', bundledSpec: previousSpec, speckifyVersion: null },
      classificationMap: map,
      toolchainImpactBump: 'none',
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning([]),
    });

    expect(plan.bump).toBe('patch');
    expect(plan.version).toBe('1.2.1');
  });

  it('publishes nothing for an identical spec vs a realistically-stamped previous version (B4)', async () => {
    const previousSpec = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Widgets', version: '1.2.0' },
      paths: {},
    });
    const currentSpec = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Widgets', version: '0.0.0' },
      paths: {},
    });

    const plan = await computeContractPlan({
      contract: 'orders-api',
      bundledSpec: currentSpec,
      previous: { version: '1.2.0', bundledSpec: previousSpec, speckifyVersion: null },
      classificationMap: map,
      toolchainImpactBump: 'none',
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning([]),
    });

    expect(plan.bump).toBe('none');
    expect(plan.version).toBe('1.2.0');
  });

  it('takes the max of the spec bump and the toolchain impact bump', async () => {
    const changes: OasdiffChange[] = [
      { id: 'request-property-added', text: 'added an optional request property', level: 1 },
    ];
    const plan = await computeContractPlan({
      contract: 'orders-api',
      bundledSpec: bundledSpecV1,
      previous: { version: '1.2.0', bundledSpec: publishedSpecV1_2_0, speckifyVersion: null },
      classificationMap: map,
      toolchainImpactBump: 'major',
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning(changes),
    });

    expect(plan.bump).toBe('major');
    expect(plan.version).toBe('2.0.0');
  });
});

describe('renderChangelogMarkdown', () => {
  it('renders "No changes." for an empty list', () => {
    expect(renderChangelogMarkdown([])).toBe('No changes.\n');
  });

  it('renders each change as a bullet, highest level first', () => {
    const changes: OasdiffChange[] = [
      { id: 'description-changed', text: 'description changed', level: 1 },
      {
        id: 'response-required-property-removed',
        text: "removed the required property 'name'",
        level: 3,
        operation: 'GET',
        path: '/widgets',
      },
    ];

    const markdown = renderChangelogMarkdown(changes);
    const lines = markdown.trim().split('\n');
    expect(lines[0]).toContain('response-required-property-removed');
    expect(lines[0]).toContain('(GET /widgets)');
    expect(lines[1]).toContain('description-changed');
  });
});

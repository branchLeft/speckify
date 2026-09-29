import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { LintError } from './lint/index.js';
import { computeContractPlan, renderChangelogMarkdown, type ContractPlan } from './plan.js';
import type { OasdiffChange, ProcessRunner } from './oasdiff/index.js';
import {
  OASDIFF_LOCATION_CLAIMS_FILENAME,
  OASDIFF_SILENT_CLAIMS_FILENAME,
} from './oasdiff/version.js';
import { loadOasdiffCoverage, type ClassificationMap } from './version/index.js';

const map: ClassificationMap = {
  'response-required-property-removed': 'major',
  'request-property-added': 'minor',
  'response-optional-property-added': 'minor',
  'request-property-minlength-tightened': 'minor',
};

const dataDir = fileURLToPath(new URL('../data/', import.meta.url));

/** The real, committed location coverage Speckify ships (see version/location-coverage.md). */
const coverage = await loadOasdiffCoverage(
  join(dataDir, OASDIFF_LOCATION_CLAIMS_FILENAME),
  join(dataDir, OASDIFF_SILENT_CLAIMS_FILENAME),
);

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
        coverage,
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
        coverage,
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
      coverage,
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
      coverage,
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
      coverage,
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
      coverage,
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
      coverage,
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
      coverage,
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
      coverage,
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
      coverage,
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
      coverage,
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
      coverage,
      toolchainImpactBump: 'major',
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning(changes),
    });

    expect(plan.bump).toBe('major');
    expect(plan.version).toBe('2.0.0');
  });

  it('forces major for a structural change at a location oasdiff has no rule for, even alongside a real, correctly-classified change oasdiff DOES report (N3b)', async () => {
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
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { id: { type: 'string' } },
                    },
                  },
                },
              },
            },
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
                  // additionalProperties tightened: oasdiff has no rule
                  // for this keyword at all (confirmed against the real
                  // 1.32.1 rule catalogue), so it stays silent about it.
                  schema: { type: 'object', additionalProperties: false },
                },
              },
            },
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      // An unrelated, genuinely additive response
                      // property -- the kind oasdiff correctly classifies
                      // as minor on its own.
                      properties: {
                        id: { type: 'string' },
                        notes: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const plan = await computeContractPlan({
      contract: 'orders-api',
      bundledSpec: currentSpec,
      previous: { version: '1.2.0', bundledSpec: previousSpec, speckifyVersion: null },
      classificationMap: map,
      coverage,
      toolchainImpactBump: 'none',
      // oasdiff sees (and correctly classifies as minor) the new response
      // property, but says nothing about additionalProperties -- it has no
      // rule for it. Trusting this minor bump would under-bump.
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning([
        {
          id: 'response-optional-property-added',
          text: "added the optional property 'notes'",
          level: 1,
          operation: 'POST',
          path: '/widgets',
        },
      ]),
    });

    expect(plan.bump).toBe('major');
    expect(plan.version).toBe('2.0.0');
  });

  it('does not lose a real change nested inside a property literally named "title": the doc-key stripper is position-aware (N3a)', async () => {
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
                  schema: {
                    type: 'object',
                    properties: {
                      // A property that happens to be named exactly like
                      // one of DOC_ONLY_KEYS. Its own nested schema must
                      // survive stripping intact -- it is data, not an
                      // annotation.
                      title: { type: 'object', additionalProperties: true },
                    },
                  },
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
                  schema: {
                    type: 'object',
                    properties: {
                      // Only this nested, uncovered location differs -- a
                      // stripper that deletes the "title" property outright
                      // (rather than only stripping *annotation-position*
                      // doc keys) would make both sides look identical here
                      // and under-bump to patch.
                      title: { type: 'object', additionalProperties: false },
                    },
                  },
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
      coverage,
      toolchainImpactBump: 'none',
      // oasdiff has no rule for additionalProperties, so it stays silent.
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning([]),
    });

    expect(plan.bump).toBe('major');
    expect(plan.version).toBe('2.0.0');
  });

  it("trusts oasdiff's own classification when every structural change is at a covered location (N3b)", async () => {
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
                  schema: {
                    type: 'object',
                    properties: { name: { type: 'string', minLength: 1 } },
                  },
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
                  schema: {
                    type: 'object',
                    // minLength tightened: a covered location, so oasdiff's
                    // own classification (minor, per `map`) stands rather
                    // than being forced to major.
                    properties: { name: { type: 'string', minLength: 5 } },
                  },
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
      coverage,
      toolchainImpactBump: 'none',
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning([
        {
          id: 'request-property-minlength-tightened',
          text: "tightened 'minLength' on request property 'name'",
          level: 1,
          operation: 'POST',
          path: '/widgets',
        },
      ]),
    });

    expect(plan.bump).toBe('minor');
    expect(plan.version).toBe('1.3.0');
  });
});

describe('computeContractPlan: location coverage (offline, stubbed oasdiff output)', () => {
  function spec(version: string, itemsMaxLength: number, notes: boolean): string {
    const responseProperties: Record<string, unknown> = { id: { type: 'string' } };
    if (notes) responseProperties.notes = { type: 'string' };
    return JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Things', version },
      paths: {
        '/things': {
          get: {
            operationId: 'listThings',
            parameters: [
              {
                name: 'tags',
                in: 'query',
                schema: { type: 'array', items: { type: 'string', maxLength: itemsMaxLength } },
              },
            ],
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: responseProperties },
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  const optionalPropertyAdded: OasdiffChange = {
    id: 'response-optional-property-added',
    text: "added the optional property 'notes'",
    level: 1,
    operation: 'GET',
    path: '/things',
  };

  async function planFor(
    bundledSpec: string,
    previousSpec: string,
    changes: OasdiffChange[],
  ): Promise<ContractPlan> {
    return computeContractPlan({
      contract: 'things',
      bundledSpec,
      previous: { version: '1.2.3', bundledSpec: previousSpec, speckifyVersion: null },
      classificationMap: map,
      coverage,
      toolchainImpactBump: 'none',
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning(changes),
    });
  }

  it('forces major for an unjudged parameter items.maxLength beside a judged minor change', async () => {
    const plan = await planFor(spec('0.0.0', 5, true), spec('1.2.3', 50, false), [
      optionalPropertyAdded,
    ]);
    expect(plan.version).toBe('2.0.0');
    expect(plan.uncovered.map((u) => [u.edit.location.join('.'), u.reason])).toEqual([
      ['paths./things.get.parameters.query:tags.schema.items.maxLength', 'no-claim'],
    ]);
  });

  it('keeps the judged minor when that is the only change', async () => {
    const plan = await planFor(spec('0.0.0', 50, true), spec('1.2.3', 50, false), [
      optionalPropertyAdded,
    ]);
    expect(plan.version).toBe('1.3.0');
    expect(plan.uncovered).toEqual([]);
  });

  it('forces major when oasdiff reported nothing for the operation a covered edit is in', async () => {
    const plan = await planFor(spec('0.0.0', 50, true), spec('1.2.3', 50, false), [
      { ...optionalPropertyAdded, path: '/elsewhere' },
    ]);
    expect(plan.version).toBe('2.0.0');
    expect(plan.uncovered.map((u) => u.reason)).toEqual(['unreported-operation']);
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

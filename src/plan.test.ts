import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { LintError } from './lint/index.js';
import { computeContractPlan, renderChangelogMarkdown, type ContractPlan } from './plan.js';
import type { OasdiffChange, ProcessRunner } from './oasdiff/index.js';
import {} from './oasdiff/version.js';
import type { ClassificationMap } from './version/index.js';
import { unchangedSurface } from './surface/test-support.js';

const map: ClassificationMap = {
  'response-required-property-removed': 'major',
  'request-property-added': 'minor',
  'response-optional-property-added': 'minor',
  'request-property-minlength-tightened': 'minor',
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
        surfaceDiff: unchangedSurface,
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
        surfaceDiff: unchangedSurface,
        oasdiffPath: '/bin/oasdiff',
        runProcess,
      }),
    ).rejects.toThrow(LintError);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('refuses (never bumps minor) a response schema gaining a property that collides with a generated Python model member', async () => {
    // The cycle-7 blocker: GET /things gaining an optional
    // `additional_properties` property is exactly what oasdiff and the
    // surface diff would otherwise wave through as minor — lint must stop
    // it before either ever runs.
    const runProcess = vi.fn();
    const specWithCollidingProperty = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Widgets', version: '0.0.0' },
      paths: {
        '/things': {
          get: {
            operationId: 'listThings',
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { additional_properties: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const attempt = computeContractPlan({
      contract: 'orders-api',
      bundledSpec: specWithCollidingProperty,
      previous: { version: '1.2.0', bundledSpec: publishedSpecV1_2_0, speckifyVersion: null },
      classificationMap: map,
      toolchainImpactBump: 'none',
      surfaceDiff: unchangedSurface,
      oasdiffPath: '/bin/oasdiff',
      runProcess,
    });

    await expect(attempt).rejects.toThrow(LintError);
    await attempt.catch((error: unknown) => {
      expect((error as LintError).findings.map((f) => f.ruleId)).toContain(
        'reserved-python-model-member',
      );
    });
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
      surfaceDiff: unchangedSurface,
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
      surfaceDiff: unchangedSurface,
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
      surfaceDiff: unchangedSurface,
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
      surfaceDiff: unchangedSurface,
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
      surfaceDiff: unchangedSurface,
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
      surfaceDiff: unchangedSurface,
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
      surfaceDiff: unchangedSurface,
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
      surfaceDiff: unchangedSurface,
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
      surfaceDiff: unchangedSurface,
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
      surfaceDiff: unchangedSurface,
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
      toolchainImpactBump: 'none',
      surfaceDiff: unchangedSurface,
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
                      // Only this nested location differs -- a
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
      toolchainImpactBump: 'none',
      surfaceDiff: unchangedSurface,
      // oasdiff has no rule for additionalProperties, so it stays silent.
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning([]),
    });

    expect(plan.bump).toBe('major');
    expect(plan.version).toBe('2.0.0');
  });

  it('bumps major for a request minLength tightening even when oasdiff labels it minor', async () => {
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
                    // minLength tightened: no allow-list rule matches, so
                    // oasdiff's minor label (per `map`) cannot lower it.
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
      toolchainImpactBump: 'none',
      surfaceDiff: unchangedSurface,
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

    expect(plan.bump).toBe('major');
    expect(plan.version).toBe('2.0.0');
  });
});

describe('computeContractPlan: the allow-list gate (offline, stubbed oasdiff output)', () => {
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
      toolchainImpactBump: 'none',
      surfaceDiff: unchangedSurface,
      oasdiffPath: '/bin/oasdiff',
      runProcess: runProcessReturning(changes),
    });
  }

  const judged = (plan: ContractPlan): string[][] =>
    plan.judgements.map((j) => [j.edit.location.join('.'), j.bump, String(j.rule)]);

  it('forces major for a parameter items.maxLength tightening beside an allowed minor change', async () => {
    const plan = await planFor(spec('0.0.0', 5, true), spec('1.2.3', 50, false), [
      optionalPropertyAdded,
    ]);
    expect(plan.version).toBe('2.0.0');
    expect(judged(plan)).toEqual([
      ['paths./things.get.parameters.query:tags.schema.items.maxLength', 'major', 'undefined'],
      [
        'paths./things.get.responses.200.content.application/json.schema.properties.notes',
        'minor',
        'response-optional-property-added',
      ],
    ]);
  });

  it('keeps the allowed minor when that is the only change', async () => {
    const plan = await planFor(spec('0.0.0', 50, true), spec('1.2.3', 50, false), [
      optionalPropertyAdded,
    ]);
    expect(plan.version).toBe('1.3.0');
  });

  it('keeps the allowed minor even when oasdiff reports nothing at all', async () => {
    const plan = await planFor(spec('0.0.0', 50, true), spec('1.2.3', 50, false), []);
    expect(plan.version).toBe('1.3.0');
  });

  it('lets oasdiff raise an allowed minor to major, never lower it', async () => {
    const plan = await planFor(spec('0.0.0', 50, true), spec('1.2.3', 50, false), [
      { ...optionalPropertyAdded, id: 'response-required-property-removed' },
    ]);
    expect(plan.version).toBe('2.0.0');
  });

  it('bumps major when only an unreadable difference remains (a reordered enum)', async () => {
    const withEnum = (version: string, values: string[]): string => {
      const doc = JSON.parse(spec(version, 50, false)) as {
        paths: Record<string, { get: { parameters: { schema: Record<string, unknown> }[] } }>;
      };
      const parameter = doc.paths['/things']?.get.parameters[0];
      if (parameter !== undefined) parameter.schema.items = { type: 'string', enum: values };
      return JSON.stringify(doc);
    };
    const plan = await planFor(withEnum('0.0.0', ['b', 'a']), withEnum('1.2.3', ['a', 'b']), []);
    expect(plan.judgements).toEqual([]);
    expect(plan.version).toBe('2.0.0');
  });

  it('bumps patch for an extension no generator reads, major for one a generator reads', async () => {
    const withExtension = (version: string, extension: Record<string, unknown>): string => {
      const doc = JSON.parse(spec(version, 50, false)) as Record<string, unknown>;
      return JSON.stringify({ ...doc, ...extension });
    };
    const base = withExtension('1.2.3', {});
    const inert = await planFor(withExtension('0.0.0', { 'x-owner': 'team-a' }), base, []);
    expect(inert.version).toBe('1.2.4');
    const read = JSON.parse(spec('0.0.0', 50, false)) as {
      paths: Record<string, { get: Record<string, unknown> }>;
    };
    const operation = read.paths['/things']?.get;
    if (operation !== undefined) operation['x-enum-varnames'] = ['A'];
    const sdk = await planFor(JSON.stringify(read), base, []);
    expect(sdk.version).toBe('2.0.0');
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

describe('computeContractPlan and the generated-surface diff', () => {
  const previous = { version: '1.2.0', bundledSpec: publishedSpecV1_2_0, speckifyVersion: null };
  const input = {
    contract: 'orders-api',
    classificationMap: map,
    toolchainImpactBump: 'none' as const,
    oasdiffPath: '/bin/oasdiff',
    runProcess: runProcessReturning([]),
  };

  it('is major when the same spec generates a different surface, as a generator change would', async () => {
    const surfaceDiff = vi.fn(async () =>
      Promise.resolve({
        bump: 'major' as const,
        changes: [
          {
            language: 'typescript' as const,
            symbol: '.#Pet',
            bump: 'major' as const,
            reason: 'export removed',
          },
        ],
        serverChanges: [],
      }),
    );
    const plan = await computeContractPlan({
      ...input,
      bundledSpec: bundledSpecV1,
      previous,
      surfaceDiff,
    });
    expect(plan.bump).toBe('major');
    expect(plan.version).toBe('2.0.0');
    expect(plan.surface?.changes).toHaveLength(1);
    // Both sides reach the generators with info.version normalised.
    const [previousSpec, currentSpec] = surfaceDiff.mock.calls[0] as unknown as [string, string];
    expect(previousSpec).toBe(currentSpec);
  });

  it('raises a spec-level none to minor for a compatible surface change', async () => {
    const plan = await computeContractPlan({
      ...input,
      bundledSpec: bundledSpecV1,
      previous,
      surfaceDiff: () => Promise.resolve({ bump: 'minor', changes: [], serverChanges: [] }),
    });
    expect(plan.bump).toBe('minor');
  });

  it('runs no surface diff on a first publish', async () => {
    const surfaceDiff = vi.fn(unchangedSurface);
    const plan = await computeContractPlan({
      ...input,
      bundledSpec: bundledSpecV1,
      previous: null,
      surfaceDiff,
    });
    expect(surfaceDiff).not.toHaveBeenCalled();
    expect(plan.surface).toBeNull();
  });

  it.each([
    ['op-added-CreateThing', 'operation-id'],
    ['param-Page-Size-beside-page_size', 'parameter-names'],
  ])('lint refuses %s before the surface diff runs', async (fixture, ruleId) => {
    const read = (side: string): string =>
      readFileSync(new URL(`./surface/fixtures/${fixture}.${side}.json`, import.meta.url), 'utf8');
    const surfaceDiff = vi.fn(unchangedSurface);
    const attempt = computeContractPlan({
      ...input,
      bundledSpec: read('rev'),
      previous: { ...previous, bundledSpec: read('base') },
      surfaceDiff,
    });
    await expect(attempt).rejects.toThrow(LintError);
    await attempt.catch((error: unknown) => {
      expect((error as LintError).findings.map((f) => f.ruleId)).toContain(ruleId);
    });
    expect(surfaceDiff).not.toHaveBeenCalled();
  });
});

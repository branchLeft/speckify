import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { toCanonicalJson } from '../bundle/canonical-json.js';
import { hasUv, TOOLCHAIN_DIR } from '../codegen/python/test-support.js';
import { computeContractPlan } from '../plan.js';
import { compareGeneratedSurfaces, type SurfaceTargets } from './index.js';
import type { SurfaceChange, SurfaceLanguage } from './types.js';

const uvAvailable = await hasUv();

function fixture(name: string, side: 'base' | 'rev', raw = false): string {
  const path = fileURLToPath(new URL(`./fixtures/${name}.${side}.json`, import.meta.url));
  const text = readFileSync(path, 'utf8');
  return raw ? text : toCanonicalJson(JSON.parse(text));
}

const CLIENTS: SurfaceTargets = {
  typescript: { client: true, server: false },
  python: { client: true, server: false },
};

async function surface(
  name: string,
  options: { raw?: boolean; targets?: SurfaceTargets; same?: boolean } = {},
): Promise<{
  bump: string;
  changes: readonly SurfaceChange[];
  serverChanges: readonly SurfaceChange[];
}> {
  const previousSpec = fixture(name, 'base', options.raw);
  return compareGeneratedSurfaces({
    previousSpec,
    currentSpec: options.same === true ? previousSpec : fixture(name, 'rev', options.raw),
    targets: options.targets ?? CLIENTS,
    toolchainDir: TOOLCHAIN_DIR,
  });
}

const majorIn = (changes: readonly SurfaceChange[], language: SurfaceLanguage): string[] =>
  changes
    .filter((change) => change.language === language && change.bump === 'major')
    .map((change) => `${change.symbol}: ${change.reason}`);

const TIMEOUT = 120_000;

/** Client targets for just `languages`: a case proven in one language generates only that one. */
const only = (languages: readonly SurfaceLanguage[]): SurfaceTargets =>
  Object.fromEntries(languages.map((language) => [language, { client: true, server: false }]));

describe.skipIf(!uvAvailable)('the generated-surface diff over real generators', () => {
  describe('cycle-6 blockers', () => {
    it.each([
      ['unref-pet-beside-Pet', ['typescript', 'python']],
      ['unref-CreateThingData', ['typescript']],
      ['unref-CreateThingResponse200', ['python']],
      ['tags-reorder', ['python']],
      ['tags-reorder-with-noise', ['python']],
    ] as const)(
      '%s is major in %j',
      async (name, languages) => {
        const report = await surface(name, { targets: only(languages) });
        expect(report.bump).toBe('major');
        for (const language of languages) {
          expect(majorIn(report.changes, language), `${language} majors`).not.toEqual([]);
        }
      },
      TIMEOUT,
    );

    it(
      'a properties reorder never reaches the generators: the bundle is key-sorted, so nothing changes',
      async () => {
        expect((await surface('properties-reorder')).bump).toBe('none');
      },
      TIMEOUT,
    );

    it(
      'the same reorder fed to the generators unsorted is minor now generated attrs models are ' +
        'keyword-only: field order carries no meaning in the constructor surface any more ' +
        '(see the Python-models-keyword-only follow-up)',
      async () => {
        const report = await surface('properties-reorder', {
          raw: true,
          targets: only(['python']),
        });
        expect(majorIn(report.changes, 'python')).toEqual([]);
        expect(report.bump).toBe('minor');
        expect(report.changes.map((c) => c.reason).join('\n')).toContain('signature changed');
      },
      TIMEOUT,
    );
  });

  describe('controls', () => {
    it.each([
      ['optional-property-appended', 'minor'],
      ['endpoint-added', 'minor'],
      ['response-optional-field', 'minor'],
      ['optional-query-param', 'minor'],
      ['description-edit', 'none'],
      // Both used to be major: inserting an optional property anywhere but
      // last, or moving a property from required to optional, shifted a
      // *positional* attrs constructor argument. Now every generated attrs
      // model is keyword-only (see the Python-models-keyword-only
      // follow-up), field order carries no surface meaning, so these are
      // exactly what they look like: a harmless addition and relaxation.
      ['optional-property-mid', 'minor'],
      ['required-removed', 'minor'],
    ] as const)(
      '%s is %s',
      async (name, bump) => {
        const report = await surface(name);
        expect(report.changes.filter((c) => c.bump === 'major')).toEqual([]);
        expect(report.bump).toBe(bump);
      },
      TIMEOUT,
    );

    it(
      'an unchanged spec is none, without generating anything',
      async () => {
        expect((await surface('endpoint-added', { same: true })).bump).toBe('none');
      },
      TIMEOUT,
    );
  });

  it(
    'a new operation is minor for a contract that generates a server: the server-only Handlers ' +
      'break is reported, not fed into the bump — only the producer who changed the spec ' +
      'consumes the server package (surface.md §1)',
    async () => {
      const report = await surface('server-endpoint-added', {
        targets: {
          typescript: { client: true, server: true },
          python: { client: true, server: true },
        },
      });
      expect(report.bump).toBe('minor');
      // The client surface (TS `.`/`./types`/`./zod`, Python client+models)
      // only gains a new export for the new operation: no major there.
      expect(majorIn(report.changes, 'typescript')).toEqual([]);
      expect(majorIn(report.changes, 'python')).toEqual([]);
      // The server-only surface still reports the Handlers break, for the
      // producer's own visibility — it just doesn't drive the bump.
      expect(majorIn(report.serverChanges, 'typescript')).toEqual([
        './server#Handlers: is used as input and no longer accepts every value it accepted',
      ]);
      expect(majorIn(report.serverChanges, 'python')).toEqual([
        'speckify_surface.server.handlers.Handlers: a Protocol consumers implement changed',
      ]);
      const clientOnly = await surface('server-endpoint-added');
      expect(clientOnly.bump).toBe('minor');
      expect(clientOnly.serverChanges).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'through computeContractPlan: a tag reorder beside a harmless new response field is major, not minor',
    async () => {
      const plan = await computeContractPlan({
        contract: 'things',
        bundledSpec: fixture('tags-reorder-with-noise', 'rev'),
        previous: {
          version: '1.0.0',
          bundledSpec: fixture('tags-reorder-with-noise', 'base'),
          speckifyVersion: null,
        },
        classificationMap: {},
        toolchainImpactBump: 'none',
        oasdiffPath: '/unused/oasdiff',
        runProcess: () => Promise.resolve({ stdout: '[]', stderr: '' }),
        surfaceDiff: (previousSpec, currentSpec) =>
          compareGeneratedSurfaces({
            previousSpec,
            currentSpec,
            targets: CLIENTS,
            toolchainDir: TOOLCHAIN_DIR,
          }),
      });
      expect(plan.judgements.every((j) => j.bump !== 'major')).toBe(true);
      expect(plan.bump).toBe('major');
      expect(plan.version).toBe('2.0.0');
    },
    TIMEOUT,
  );
});

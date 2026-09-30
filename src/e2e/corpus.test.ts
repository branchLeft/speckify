import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { bundleSpec } from '../bundle/index.js';
import type { Contract } from '../config/index.js';
import { buildContract } from '../build.js';
import { importNameFor } from '../codegen/python/index.js';
import { hasUv, TOOLCHAIN_DIR } from '../codegen/python/test-support.js';
import { resolveUv } from '../codegen/python/uv.js';
import { LintError } from '../lint/index.js';
import { OASDIFF_CLASSIFICATION_MAP_FILENAME, resolveOasdiffBinary } from '../oasdiff/index.js';
import { computeContractPlan } from '../plan.js';
import { compareGeneratedSurfaces, type SurfaceReport } from '../surface/index.js';
import { unchangedSurface } from '../surface/test-support.js';
import { loadClassificationMap } from '../version/index.js';
import { spawn } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const corpusRoot = join(repoRoot, 'test', 'corpus');

/**
 * Runs the whole corpus's build/typecheck/import and package-surface-diff
 * steps only when explicitly asked: they build real TypeScript and Python
 * packages for every passing spec (plus three mutations each), which is
 * accurate but slow (single-digit minutes). CI sets this so the corpus is
 * exercised for real on every push; a local run stays fast by default and
 * still gets full lint/plan/oasdiff coverage plus a cheap self-diff.
 *
 * Filter locally with either:
 *   SPECKIFY_CORPUS_FULL=1 pnpm vitest run src/e2e/corpus.test.ts
 *   pnpm vitest run src/e2e/corpus.test.ts -t "light"
 */
const FULL = process.env.SPECKIFY_CORPUS_FULL === '1' || process.env.CI === 'true';

const uvAvailable = await hasUv();

interface Refusal {
  readonly kind: 'refused';
  readonly ruleId: string;
}
interface KnownBuildFailure {
  readonly kind: 'known-build-failure';
  readonly reason: string;
  readonly errorSubstring: string;
}
interface Passes {
  readonly kind: 'pass';
}

interface CorpusCase {
  readonly name: string;
  readonly specPath: string;
  readonly outcome: Passes | Refusal | KnownBuildFailure;
}

/**
 * Every OAI-authored example (see `test/corpus/oai/SOURCES.md`), plus one
 * large real-world spec (`test/corpus/large/SOURCES.md`). The expected
 * outcome is recorded per spec so a refusal or a known generator gap is an
 * assertion, not a surprise the next run has to rediscover.
 */
const CASES: readonly CorpusCase[] = [
  { name: 'oai/v3.0/petstore', specPath: 'oai/v3.0/petstore.yaml', outcome: { kind: 'pass' } },
  {
    name: 'oai/v3.0/petstore-expanded',
    specPath: 'oai/v3.0/petstore-expanded.yaml',
    outcome: { kind: 'pass' },
  },
  {
    name: 'oai/v3.0/api-with-examples',
    specPath: 'oai/v3.0/api-with-examples.yaml',
    outcome: { kind: 'pass' },
  },
  {
    // No operation in this spec declares an operationId; Speckify's own
    // codegen needs one to name the generated method, so it refuses the
    // spec rather than generate an unnamed or colliding function. Genuine,
    // correct behaviour on a genuine real-world spec, not a corpus quirk.
    name: 'oai/v3.0/callback-example',
    specPath: 'oai/v3.0/callback-example.yaml',
    outcome: { kind: 'refused', ruleId: 'operation-id' },
  },
  {
    name: 'oai/v3.0/link-example',
    specPath: 'oai/v3.0/link-example.yaml',
    outcome: { kind: 'pass' },
  },
  { name: 'oai/v3.0/uspto', specPath: 'oai/v3.0/uspto.yaml', outcome: { kind: 'pass' } },
  {
    // Same shape as callback-example: no operationId anywhere in the doc.
    name: 'oai/v3.1/non-oauth-scopes',
    specPath: 'oai/v3.1/non-oauth-scopes.yaml',
    outcome: { kind: 'refused', ruleId: 'operation-id' },
  },
  { name: 'oai/v3.1/tictactoe', specPath: 'oai/v3.1/tictactoe.yaml', outcome: { kind: 'pass' } },
  {
    // 3.1's "webhooks only, no paths" shape (see spec comment inline):
    // proves the pipeline doesn't assume `paths` exists.
    name: 'oai/v3.1/webhook-example',
    specPath: 'oai/v3.1/webhook-example.yaml',
    outcome: { kind: 'pass' },
  },
  {
    // Swagger 2.0, not OpenAPI 3.x: the openapi-version rule's other case.
    name: 'oai/v2.0/petstore',
    specPath: 'oai/v2.0/petstore.yaml',
    outcome: { kind: 'refused', ruleId: 'openapi-version' },
  },
  {
    // 485 operations, 3.1MB bundled. @hey-api/openapi-ts 0.99.0 (pinned)
    // silently drops 11 of them from the generated SDK/server even though
    // Speckify's own operation-id rule already proved every operationId in
    // the document is unique — see the assertion below for the exact list.
    // This is a real, reproducible gap in a pinned third-party generator on
    // a real-world spec, not a Speckify bug: nothing in Speckify's own
    // code chooses which operations the generator emits. It's the kind of
    // finding vendoring a large real spec is *for* — recorded here as a
    // known failure rather than silently skipped or, worse, "fixed" by
    // relaxing Speckify's own completeness check.
    name: 'large/digitalocean-v2',
    specPath: 'large/digitalocean-v2.bundled.yaml',
    outcome: {
      kind: 'known-build-failure',
      reason:
        '@hey-api/openapi-ts 0.99.0 drops 11 of 485 operations from the generated TS SDK/server; ' +
        'tracked as an upstream generator gap, not a Speckify defect (see plan.md discovery notes).',
      errorSubstring: 'Generation is missing 11 operation(s)',
    },
  },
];

function specFile(c: CorpusCase): string {
  return join(corpusRoot, c.specPath);
}

// ---------------------------------------------------------------------------
// Mutation helpers: operate on an already-bundled document (internal $refs
// still present, exactly what computeContractPlan/oasdiff see). Every
// mutation targets an operation's `parameters` array rather than a response
// schema: every OAI example has at least one operation, but not every one
// declares a JSON schema anywhere (api-with-examples.yaml only shows
// example payloads), and a shared response schema can be reachable from a
// webhook too (tictactoe.yaml), which inverts direction and would make the
// bump major regardless — a parameter is added fresh on one operation, so
// it can never be shared with anything else.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

interface FoundOperation {
  readonly operation: Record<string, unknown>;
  /**
   * Whether the operation lives under `paths` (normal request/response
   * direction) or `webhooks` (inverted — allow-list.md §3: "No v1 rule
   * allows anything under them, so any change there is major").
   */
  readonly inverted: boolean;
}

/** The first operation under `paths`, or, failing that, the first under `webhooks` (OAS 3.1's webhooks-only shape). */
function firstOperation(doc: Record<string, unknown>): FoundOperation | null {
  for (const [containerKey, inverted] of [
    ['paths', false],
    ['webhooks', true],
  ] as const) {
    const container = doc[containerKey];
    if (!isRecord(container)) continue;
    for (const pathItem of Object.values(container)) {
      if (!isRecord(pathItem)) continue;
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (isRecord(operation)) {
          return { operation, inverted };
        }
      }
    }
  }
  return null;
}

function addQueryParameter(operation: Record<string, unknown>, required: boolean): void {
  const existing: unknown = operation.parameters;
  const parameters: unknown[] = Array.isArray(existing) ? (existing as unknown[]).slice() : [];
  parameters.push({
    name: 'xCorpusMutationProbe',
    in: 'query',
    required,
    schema: { type: 'string' },
  });
  operation.parameters = parameters;
}

interface Mutation {
  readonly name: string;
  /** `paths`-rooted expectation; a webhooks-only spec expects `major` for both parameter mutations instead (see `expectedBumpFor`). */
  readonly expectedBump: 'patch' | 'minor' | 'major';
  readonly apply: (doc: Record<string, unknown>) => void;
}

/** The bump a mutation actually expects for `doc`: webhooks invert direction, so no parameter rule ever applies there. */
function expectedBumpFor(
  mutation: Mutation,
  doc: Record<string, unknown>,
): 'patch' | 'minor' | 'major' {
  if (mutation.expectedBump === 'patch') return 'patch';
  const found = firstOperation(doc);
  return found?.inverted === true ? 'major' : mutation.expectedBump;
}

/**
 * Three mutations every corpus spec is scripted against, matching
 * `src/version/allow-list.md` §5 exactly: `doc-only` (patch),
 * `optional-parameter-added` (minor), and a new *required* parameter,
 * which the allow-list deliberately excludes from `optional-parameter-added`
 * ("`required` absent or false") and which falls to major under §5's
 * closing rule ("Everything else is major").
 */
const MUTATIONS: readonly Mutation[] = [
  {
    name: 'description edit (doc-only)',
    expectedBump: 'patch',
    apply: (doc): void => {
      const info = doc.info;
      if (isRecord(info)) {
        info.description = `${typeof info.description === 'string' ? info.description : ''}\n\nCorpus mutation probe.`;
      }
    },
  },
  {
    name: 'add optional query parameter',
    expectedBump: 'minor',
    apply: (doc): void => {
      const found = firstOperation(doc);
      if (found === null) {
        throw new Error('no operation found for this spec');
      }
      addQueryParameter(found.operation, false);
    },
  },
  {
    name: 'add required query parameter',
    expectedBump: 'major',
    apply: (doc): void => {
      const found = firstOperation(doc);
      if (found === null) {
        throw new Error('no operation found for this spec');
      }
      addQueryParameter(found.operation, true);
    },
  },
];

function typecheckStrictConsumer(entryFile: string): string[] {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: false,
    esModuleInterop: true,
    noEmit: true,
  };
  const program = ts.createProgram([entryFile], compilerOptions);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  const host: ts.FormatDiagnosticsHost = {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (f) => f,
    getNewLine: () => ts.sys.newLine,
  };
  return diagnostics.map((d) => ts.formatDiagnostic(d, host).trim());
}

async function findWheel(distDir: string): Promise<string> {
  const entries = await readdir(distDir);
  const wheel = entries.find((name) => name.endsWith('.whl'));
  if (wheel === undefined) {
    throw new Error(`no wheel found in ${distDir}`);
  }
  return join(distDir, wheel);
}

/** Runs `python -c <code>` inside an ephemeral uv environment with `wheelPath` installed. */
async function runPythonWithWheel(wheelPath: string, code: string): Promise<string> {
  const uvPath = await resolveUv();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(uvPath, [
      'run',
      '--no-project',
      '--python',
      '3.13',
      '--with',
      wheelPath,
      'python',
      '-c',
      code,
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`python -c failed (exit ${String(exitCode)}):\n${stderr}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

describe('corpus: OAI-authored examples and one large real-world spec', () => {
  const outDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(outDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  for (const testCase of CASES) {
    describe(testCase.name, () => {
      it('light: bundles, lints and computes a first-publish plan as expected', async () => {
        const t0 = Date.now();
        const bundledSpec = await bundleSpec(specFile(testCase), {
          repoRoot: dirname(specFile(testCase)),
        });
        const classificationMap = await loadClassificationMap(
          resolve(repoRoot, 'data', OASDIFF_CLASSIFICATION_MAP_FILENAME),
        );
        const oasdiffPath = await resolveOasdiffBinary({
          cacheDir: join(tmpdir(), 'speckify-corpus-oasdiff-cache'),
        });

        if (testCase.outcome.kind === 'refused') {
          const outcome = testCase.outcome;
          try {
            await computeContractPlan({
              contract: testCase.name,
              bundledSpec,
              previous: null,
              classificationMap,
              toolchainImpactBump: 'none',
              surfaceDiff: unchangedSurface,
              oasdiffPath,
            });
            expect.fail(`expected a LintError with ruleId "${outcome.ruleId}"`);
          } catch (err) {
            expect(err).toBeInstanceOf(LintError);
            const lintErr = err as LintError;
            expect(lintErr.findings.map((f) => f.ruleId)).toContain(outcome.ruleId);
          }
          console.log(`[corpus timing] ${testCase.name} (refused): ${String(Date.now() - t0)}ms`);
          return;
        }

        const plan = await computeContractPlan({
          contract: testCase.name,
          bundledSpec,
          previous: null,
          classificationMap,
          toolchainImpactBump: 'none',
          surfaceDiff: unchangedSurface,
          oasdiffPath,
        });
        expect(plan.version).toBe('1.0.0');
        expect(plan.bump).toBe('none');

        // Self-diff: previous and current are the same spec, byte for byte.
        // `compareGeneratedSurfaces` short-circuits on identical strings
        // (surface/index.ts), so this stays cheap even outside `FULL`.
        const selfPlan = await computeContractPlan({
          contract: testCase.name,
          bundledSpec: plan.bundledSpec,
          previous: {
            version: plan.version,
            bundledSpec: plan.bundledSpec,
            speckifyVersion: '0.0.0-test',
          },
          classificationMap,
          toolchainImpactBump: 'none',
          surfaceDiff: (previousSpec, currentSpec) =>
            compareGeneratedSurfaces({
              previousSpec,
              currentSpec,
              targets: { typescript: { client: true, server: true } },
            }),
          oasdiffPath,
        });
        expect(selfPlan.bump).toBe('none');

        // The three scripted mutations, using the real oasdiff binary. The
        // package-surface diff itself (`compareGeneratedSurfaces`, real TS
        // + Python generation on both sides) only runs under `FULL` — see
        // the module doc comment — everywhere else `unchangedSurface`
        // stands in, so the oasdiff/allow-list gate is still proven for
        // real on every run, just without the extra generation cost. A
        // known-build-failure spec (the DigitalOcean fixture) never gets
        // the real surface diff at all: its TS build is already known to
        // fail, so generating it again here would only fail the same way a
        // second time, for no new signal.
        const useRealSurfaceDiff = FULL && testCase.outcome.kind !== 'known-build-failure';
        for (const mutation of MUTATIONS) {
          const mt0 = Date.now();
          const base = JSON.parse(plan.bundledSpec) as Record<string, unknown>;
          const revision = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
          mutation.apply(revision);
          const revisionJson = JSON.stringify(revision);
          const expectedBump = expectedBumpFor(mutation, base);

          const mutationPlan = await computeContractPlan({
            contract: testCase.name,
            bundledSpec: revisionJson,
            previous: {
              version: plan.version,
              bundledSpec: plan.bundledSpec,
              speckifyVersion: '0.0.0-test',
            },
            classificationMap,
            toolchainImpactBump: 'none',
            surfaceDiff: useRealSurfaceDiff
              ? (previousSpec, currentSpec): Promise<SurfaceReport> =>
                  compareGeneratedSurfaces({
                    previousSpec,
                    currentSpec,
                    targets: { typescript: { client: true, server: true } },
                  })
              : unchangedSurface,
            oasdiffPath,
          });
          console.log(
            `[corpus timing] ${testCase.name} mutation "${mutation.name}": ${String(Date.now() - mt0)}ms`,
          );
          expect(mutationPlan.bump, `${testCase.name}: ${mutation.name}`).toBe(expectedBump);
        }

        console.log(`[corpus timing] ${testCase.name} (light total): ${String(Date.now() - t0)}ms`);
      }, 60_000);

      it.skipIf(!FULL)(
        'full: builds both TypeScript and Python packages and they typecheck/import',
        async () => {
          const t0 = Date.now();
          const bundledSpec = await bundleSpec(specFile(testCase), {
            repoRoot: dirname(specFile(testCase)),
          });
          const classificationMap = await loadClassificationMap(
            resolve(repoRoot, 'data', OASDIFF_CLASSIFICATION_MAP_FILENAME),
          );
          const oasdiffPath = await resolveOasdiffBinary({
            cacheDir: join(tmpdir(), 'speckify-corpus-oasdiff-cache'),
          });

          if (testCase.outcome.kind === 'refused') {
            return; // covered entirely by the light test above.
          }

          const plan = await computeContractPlan({
            contract: testCase.name,
            bundledSpec,
            previous: null,
            classificationMap,
            toolchainImpactBump: 'none',
            surfaceDiff: unchangedSurface,
            oasdiffPath,
          });

          const packageBaseName = testCase.name.replace(/[^a-zA-Z0-9]+/g, '-');
          const contract: Contract = {
            name: packageBaseName,
            spec: testCase.specPath,
            typescript: {
              package: `@speckify-corpus/${packageBaseName}`,
              client: true,
              server: true,
            },
            ...(uvAvailable
              ? {
                  python: {
                    package: `speckify-corpus-${packageBaseName}`,
                    client: true,
                    server: true,
                  },
                }
              : {}),
          };

          const outDir = await mkdtemp(join(tmpdir(), 'speckify-corpus-build-'));
          outDirs.push(outDir);

          if (testCase.outcome.kind === 'known-build-failure') {
            const failure = testCase.outcome;
            await expect(
              buildContract(plan, {
                contract,
                speckifyVersion: '0.0.0-test',
                toolchainDir: TOOLCHAIN_DIR,
                outDir,
              }),
            ).rejects.toThrow(failure.errorSubstring);
            console.log(
              `[corpus timing] ${testCase.name} (full, known failure): ${String(Date.now() - t0)}ms`,
            );
            return;
          }

          const result = await buildContract(plan, {
            contract,
            speckifyVersion: '0.0.0-test',
            toolchainDir: TOOLCHAIN_DIR,
            outDir,
          });

          if (result.typescript === undefined) {
            throw new Error('expected a typescript build result');
          }
          if (contract.typescript === undefined) {
            throw new Error('expected the contract to declare a typescript target');
          }
          const tsPackageName = contract.typescript.package;
          const consumerDir = join(result.typescript.dir, 'consumer-check');
          const consumerFile = join(consumerDir, 'consumer.ts');
          await mkdir(consumerDir, { recursive: true });
          await writeFile(
            consumerFile,
            [
              `import * as client from '${tsPackageName}';`,
              `import * as server from '${tsPackageName}/server';`,
              'void client;',
              'void server;',
            ].join('\n'),
            'utf8',
          );
          expect(typecheckStrictConsumer(consumerFile)).toEqual([]);

          if (uvAvailable && result.python !== undefined) {
            const wheelPath = await findWheel(result.python.distDir);
            const importName = importNameFor(contract.python?.package ?? packageBaseName);
            const output = await runPythonWithWheel(
              wheelPath,
              [
                `import ${importName}`,
                `import ${importName}.models as models`,
                `import ${importName}.client as client`,
                'print("IMPORT_OK")',
              ].join('\n'),
            );
            expect(output).toContain('IMPORT_OK');
          }

          console.log(`[corpus timing] ${testCase.name} (full): ${String(Date.now() - t0)}ms`);
        },
        180_000,
      );
    });
  }
});

import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

import { bundleSpec } from '../bundle/index.js';
import { buildContract, type BuildContractResult } from '../build.js';
import type { Contract } from '../config/index.js';
import { hasUv, TOOLCHAIN_DIR } from '../codegen/python/test-support.js';
import { resolveUv } from '../codegen/python/uv.js';
import { OASDIFF_CLASSIFICATION_MAP_FILENAME, resolveOasdiffBinary } from '../oasdiff/index.js';
import { computeContractPlan, type ContractPlan, type SurfaceDiff } from '../plan.js';
import { compareGeneratedSurfaces, type SurfaceReport } from '../surface/index.js';
import { loadClassificationMap } from '../version/index.js';
import type { ClassificationMap } from '../version/types.js';

/**
 * A real-world, in-earnest dogfood: bundle a tiny notes API, plan and build
 * both languages, and drive a live TypeScript client against a live Python
 * server (and the reverse pair) through four upgrade rounds -- a first
 * publish, a patch, a minor and a major. Building and running two real
 * servers per round is expensive, so this follows corpus.test.ts's own
 * gating: CI=true or SPECKIFY_CORPUS_FULL=1. See ../../examples/dogfood/ROUNDS.md
 * for what each round actually required and the bugs this exercise found.
 */
const FULL = process.env.SPECKIFY_CORPUS_FULL === '1' || process.env.CI === 'true';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exampleDir = join(repoRoot, 'examples', 'dogfood');
const appsDir = join(exampleDir, 'apps');

const uvAvailable = await hasUv();

const CONTRACT_NAME = 'dogfood-notes';
const TS_PACKAGE_NAME = '@example/dogfood-notes';
const PY_PACKAGE_NAME = 'dogfood-notes';

function contractFor(): Contract {
  return {
    name: CONTRACT_NAME,
    spec: './openapi.yaml',
    typescript: { package: TS_PACKAGE_NAME, client: true, server: true },
    python: { package: PY_PACKAGE_NAME, client: true, server: true },
  };
}

interface RoundExpectation {
  readonly n: 0 | 1 | 2 | 3;
  readonly label: string;
  readonly bump: 'none' | 'patch' | 'minor' | 'major';
  readonly version: string;
}

const ROUNDS: readonly RoundExpectation[] = [
  { n: 0, label: 'R0 first publish', bump: 'none', version: '1.0.0' },
  { n: 1, label: 'R1 description-only edit', bump: 'patch', version: '1.0.1' },
  { n: 2, label: 'R2 add optional tags + delete-note endpoint', bump: 'minor', version: '1.1.0' },
  { n: 3, label: "R3 remove body from Note's response", bump: 'major', version: '2.0.0' },
];

/** Which committed app variant each round runs: R1 needs no code change over R0. */
function appFileFor(n: number, base: string, r2: string, r3: string): string {
  if (n <= 1) return base;
  if (n === 2) return r2;
  return r3;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createNetServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not allocate a free port'));
        return;
      }
      const port = address.port;
      server.close(() => {
        resolvePromise(port);
      });
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server at ${url} never became reachable: ${String(lastError)}`);
}

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

function runOnce(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolvePromise({ stdout, stderr, exitCode });
    });
  });
}

interface LiveServer {
  stop: () => Promise<void>;
  stderr: () => string;
}

/** Spawns a long-running server and waits until `readyUrl` answers. */
async function spawnServer(
  command: string,
  args: readonly string[],
  readyUrl: string,
): Promise<LiveServer> {
  const child = spawn(command, args);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolvePromise) => {
    child.on('close', (code) => {
      resolvePromise(code);
    });
  });

  try {
    await Promise.race([
      waitForHttp(readyUrl, 20_000),
      exited.then((code) => {
        throw new Error(`server process exited early (code ${String(code)}): ${stderr}`);
      }),
    ]);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }

  return {
    stderr: () => stderr,
    stop: () =>
      new Promise((resolvePromise) => {
        child.once('close', () => {
          resolvePromise();
        });
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 3000);
      }),
  };
}

/** The apps' own tsconfig, so the options the standards gate sees are the ones used here. */
function appCompilerOptions(): ts.CompilerOptions {
  const configPath = join(repoRoot, 'examples', 'dogfood', 'apps', 'tsconfig.json');
  const read = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (read.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  }
  return ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath)).options;
}

function tsDiagnostics(entryFile: string, outDir: string): string[] {
  const compilerOptions: ts.CompilerOptions = {
    ...appCompilerOptions(),
    noEmit: false,
    outDir,
    rootDir: dirname(entryFile),
  };
  const program = ts.createProgram([entryFile], compilerOptions);
  const emitResult = program.emit();
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .concat(emitResult.diagnostics)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  const host: ts.FormatDiagnosticsHost = {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (f) => f,
    getNewLine: () => ts.sys.newLine,
  };
  return diagnostics.map((d) => ts.formatDiagnostic(d, host).trim());
}

/**
 * Copies a committed app source into a subdirectory of the generated TS
 * package it will consume, compiles it there (strict, NodeNext) and returns
 * the emitted entry point. Living inside the generated package's own
 * directory tree lets both TypeScript and Node resolve the package's bare
 * specifier (`@example/dogfood-notes[/server]`) as a self-reference against
 * that package's own `package.json` `exports` -- the same trick
 * corpus.test.ts's `typecheckStrictConsumer` relies on -- with no npm
 * install or node_modules symlink of our own to set up.
 */
async function compileConsumerApp(tsPackageDir: string, appSourcePath: string): Promise<string> {
  const baseName = basename(appSourcePath).replace(/\.ts$/, '');
  const consumerDir = join(tsPackageDir, 'consumer-app');
  const outDir = join(tsPackageDir, 'consumer-app-dist');
  await mkdir(consumerDir, { recursive: true });
  const source = await readFile(appSourcePath, 'utf8');
  const entryFile = join(consumerDir, `${baseName}.ts`);
  await writeFile(entryFile, source);

  const errors = tsDiagnostics(entryFile, outDir);
  if (errors.length > 0) {
    throw new Error(`${appSourcePath} failed strict typecheck:\n${errors.join('\n')}`);
  }
  return join(outDir, `${baseName}.js`);
}

async function findWheel(distDir: string): Promise<string> {
  const entries = await readdir(distDir);
  const wheel = entries.find((name) => name.endsWith('.whl'));
  if (wheel === undefined) {
    throw new Error(`no wheel found in ${distDir}`);
  }
  return join(distDir, wheel);
}

describe.skipIf(!FULL)(
  'examples/dogfood: real TS+Python client/server apps across four upgrade rounds',
  () => {
    if (!uvAvailable) {
      it.skip('uv not found on PATH: the Python half of this dogfood needs it', () => {
        // No-op: `it.skip` records the reason without running the body.
      });
      return;
    }

    const outDirs: string[] = [];
    const uvPathPromise = resolveUv();

    afterAll(async () => {
      await Promise.all(outDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    let previous: { version: string; bundledSpec: string; speckifyVersion: string } | null = null;
    let classificationMap: ClassificationMap | undefined;
    let oasdiffPath: string | undefined;

    for (const round of ROUNDS) {
      it(`${round.label}: plans, builds and round-trips a real TS client + Python server and a real Python client + TS server`, async () => {
        classificationMap ??= await loadClassificationMap(
          resolve(repoRoot, 'data', OASDIFF_CLASSIFICATION_MAP_FILENAME),
        );
        oasdiffPath ??= await resolveOasdiffBinary({
          cacheDir: join(tmpdir(), 'speckify-dogfood-oasdiff-cache'),
        });

        const roundSpec = join(exampleDir, 'rounds', `r${String(round.n)}`, 'openapi.yaml');
        const bundledSpec = await bundleSpec(roundSpec, {
          repoRoot: join(exampleDir, 'rounds', `r${String(round.n)}`),
        });

        const surfaceDiff: SurfaceDiff =
          previous === null
            ? (): Promise<never> => {
                throw new Error('surfaceDiff must not run on a first publish');
              }
            : (previousSpec: string, currentSpec: string): Promise<SurfaceReport> =>
                compareGeneratedSurfaces({
                  previousSpec,
                  currentSpec,
                  targets: {
                    typescript: { client: true, server: true },
                    python: { client: true, server: true },
                  },
                  toolchainDir: TOOLCHAIN_DIR,
                });

        const plan: ContractPlan = await computeContractPlan({
          contract: CONTRACT_NAME,
          bundledSpec,
          previous,
          classificationMap,
          toolchainImpactBump: 'none',
          surfaceDiff,
          oasdiffPath,
        });

        expect(plan.bump, `${round.label}: bump`).toBe(round.bump);
        expect(plan.version, `${round.label}: version`).toBe(round.version);

        previous = {
          version: plan.version,
          bundledSpec: plan.bundledSpec,
          speckifyVersion: '0.0.0-dogfood',
        };

        const outDir = await mkdtemp(join(tmpdir(), `speckify-dogfood-r${String(round.n)}-`));
        outDirs.push(outDir);

        const result: BuildContractResult = await buildContract(plan, {
          contract: contractFor(),
          speckifyVersion: '0.0.0-dogfood',
          toolchainDir: TOOLCHAIN_DIR,
          outDir,
        });
        if (result.typescript === undefined || result.python === undefined) {
          throw new Error('expected both a typescript and a python build result');
        }
        const tsPackageDir = result.typescript.dir;
        const wheelPath = await findWheel(result.python.distDir);
        const uvPath = await uvPathPromise;

        // Pair 1: TS client (generated SDK) against a real Python FastAPI
        // server (create_router over the generated Handlers Protocol).
        {
          const port = await getFreePort();
          const baseUrl = `http://127.0.0.1:${String(port)}`;
          const serverScript = join(
            appsDir,
            'py-server',
            appFileFor(round.n, 'app_r0.py', 'app_r2.py', 'app_r3.py'),
          );
          const server = await spawnServer(
            uvPath,
            [
              'run',
              '--no-project',
              '--python',
              '3.13',
              '--with',
              wheelPath,
              '--with',
              'fastapi',
              '--with',
              'uvicorn',
              'python',
              serverScript,
              '--port',
              String(port),
            ],
            `${baseUrl}/notes`,
          );
          try {
            const clientEntry = await compileConsumerApp(
              tsPackageDir,
              join(
                appsDir,
                'ts-client',
                appFileFor(round.n, 'client_r0.ts', 'client_r2.ts', 'client_r3.ts'),
              ),
            );
            const clientResult = await runOnce('node', [clientEntry, '--base-url', baseUrl]);
            if (clientResult.exitCode !== 0) {
              throw new Error(
                `TS client (pair 1) exited ${String(clientResult.exitCode)}:\n${clientResult.stderr}`,
              );
            }
            const output = JSON.parse(clientResult.stdout.trim()) as Record<string, unknown>;
            expect(output.created, `${round.label}: pair 1 created note`).toBeDefined();
          } finally {
            await server.stop();
          }
        }

        // Pair 2: Python client (generated SDK) against a real TypeScript
        // node:http server (createServer over the generated Handlers).
        {
          const port = await getFreePort();
          const baseUrl = `http://127.0.0.1:${String(port)}`;
          const serverEntry = await compileConsumerApp(
            tsPackageDir,
            join(
              appsDir,
              'ts-server',
              appFileFor(round.n, 'server_r0.ts', 'server_r2.ts', 'server_r3.ts'),
            ),
          );
          const server = await spawnServer(
            'node',
            [serverEntry, '--port', String(port)],
            `${baseUrl}/notes`,
          );
          try {
            const clientScript = join(
              appsDir,
              'py-client',
              appFileFor(round.n, 'client_r0.py', 'client_r2.py', 'client_r3.py'),
            );
            const clientResult = await runOnce(uvPath, [
              'run',
              '--no-project',
              '--python',
              '3.13',
              '--with',
              wheelPath,
              '--with',
              'httpx',
              'python',
              clientScript,
              '--base-url',
              baseUrl,
            ]);
            if (clientResult.exitCode !== 0) {
              throw new Error(
                `Python client (pair 2) exited ${String(clientResult.exitCode)}:\n${clientResult.stderr}`,
              );
            }
            const lines = clientResult.stdout.trim().split('\n');
            const output = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
            expect(output.created, `${round.label}: pair 2 created note`).toBeDefined();
          } finally {
            await server.stop();
          }
        }
      }, 180_000);
    }
  },
);

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { hasUv } from '../codegen/python/test-support.js';

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exampleDir = join(repoRoot, 'examples', 'pet-shelter');
const cliPath = join(repoRoot, 'dist', 'cli.js');

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

const uvAvailable = await hasUv();
const networkAvailable = await reachable('https://registry.npmjs.org');

/**
 * Runs the *built* CLI, not the TypeScript source under vitest --
 * src/e2e/pet-shelter.test.ts runs against src/ directly, so it never
 * notices when `pnpm build` fails to carry a runtime asset (a Jinja2
 * template, the raw TS server-adapter template) into dist/. server:true
 * on both languages exercises the templates only server codegen reads.
 * This contract's package names have never been published to either real
 * registry hit here, so `resolvePreviousState` naturally resolves to
 * "never published" without this test writing to either.
 */
describe.skipIf(!networkAvailable)('the built CLI (node dist/cli.js build)', () => {
  it('generates and builds server code for both languages from dist, using templates dist must carry', async () => {
    await execFileAsync('npm', ['run', 'build'], { cwd: repoRoot });
    // A first publish never runs the surface diff, so its extractor is checked directly.
    await expect(
      readFile(join(repoRoot, 'dist', 'surface', 'python', 'extract_surface.py'), 'utf8'),
    ).resolves.toContain('import griffe');

    const workDir = await mkdtemp(join(tmpdir(), 'speckify-built-cli-'));
    try {
      await cp(join(exampleDir, 'openapi.yaml'), join(workDir, 'openapi.yaml'));

      const speckifyYaml = [
        'contracts:',
        '  - name: pet-shelter-built-cli-e2e',
        '    spec: ./openapi.yaml',
        '    typescript:',
        '      package: "@speckify-built-cli-e2e/pet-shelter"',
        '      client: true',
        '      server: true',
        ...(uvAvailable
          ? [
              '    python:',
              '      package: speckify-built-cli-e2e-pet-shelter',
              '      client: true',
              '      server: true',
              '',
            ]
          : ['']),
        'publish:',
        '  githubPackages:',
        '    owner: speckify-built-cli-e2e',
        '',
      ].join('\n');
      await writeFile(join(workDir, 'speckify.yaml'), speckifyYaml, 'utf8');

      const outDir = join(workDir, 'out');
      await execFileAsync(
        process.execPath,
        [cliPath, 'build', '-c', join(workDir, 'speckify.yaml'), '-o', outDir],
        { cwd: workDir, env: { ...process.env, GITHUB_TOKEN: '' } },
      );

      // The TS server adapter is only produced by copying
      // templates/server-adapter.template.ts's raw source at runtime; tsc's
      // own build never emits that file into dist under that name.
      const serverAdapter = await readFile(
        join(outDir, 'pet-shelter-built-cli-e2e', 'typescript', 'src', 'server-adapter.ts'),
        'utf8',
      );
      expect(serverAdapter).toContain('createRequestListener');

      if (uvAvailable) {
        // The Python server submodule is rendered by render_server.py via
        // its Jinja2 templates -- none of which are .ts files tsc copies.
        const router = await readFile(
          join(
            outDir,
            'pet-shelter-built-cli-e2e',
            'python',
            'src',
            'speckify_built_cli_e2e_pet_shelter',
            'server',
            'router.py',
          ),
          'utf8',
        );
        expect(router).toContain('def create_router');
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 180_000);

  // The tarball is what gets attested and then published, so it has to be the
  // real thing: the bytes `npm pack` wrote, carrying the manifest fields that
  // let it publish with no hand edits, with a digest the manifest records.
  // Only the packing half runs for real here; publishing would reach a
  // registry. The publishing half's refusal to publish a tarball that is not
  // the packed one is checked against the same real tarball, and runs before
  // anything could be sent.
  it('packs a real tarball with --pack-only, and --from-pack refuses it once its bytes change', async () => {
    await execFileAsync('npm', ['run', 'build'], { cwd: repoRoot });

    // Through realpath, because the CLI prints the paths its own cwd resolves
    // to, and the temp directory is a symlink on macOS.
    const workDir = await realpath(await mkdtemp(join(tmpdir(), 'speckify-built-cli-pack-')));
    try {
      await cp(join(exampleDir, 'openapi.yaml'), join(workDir, 'openapi.yaml'));
      await writeFile(
        join(workDir, 'speckify.yaml'),
        [
          'contracts:',
          '  - name: pet-shelter-pack-e2e',
          '    spec: ./openapi.yaml',
          '    typescript:',
          '      package: "@speckify-pack-e2e/pet-shelter"',
          '      client: true',
          '',
          'publish:',
          '  githubPackages:',
          '    owner: speckify-pack-e2e',
          '    access: public',
          '',
        ].join('\n'),
        'utf8',
      );
      const env = {
        ...process.env,
        GITHUB_TOKEN: '',
        NODE_AUTH_TOKEN: '',
        GITHUB_REPOSITORY: 'speckify-pack-e2e/pet-shelter',
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        [cliPath, 'publish', '--pack-only', '-c', 'speckify.yaml'],
        { cwd: workDir, env },
      );

      const packDir = join(workDir, '.speckify', 'pack');
      const manifest = JSON.parse(await readFile(join(packDir, 'speckify-pack.json'), 'utf8')) as {
        contracts: { targets: { kind: string; tarball: string; sha256: string }[] }[];
      };
      const target = manifest.contracts[0]?.targets[0];
      if (target?.kind !== 'npm') {
        throw new Error(`expected one npm target in the manifest, got ${JSON.stringify(manifest)}`);
      }
      const tarball = join(packDir, target.tarball);
      const bytes = await readFile(tarball);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(target.sha256);
      expect(stdout).toContain(`tarball: ${tarball} sha256:${target.sha256}`);
      expect(stdout).toContain('pet-shelter-pack-e2e-typescript: packed');

      const { stdout: packageJsonText } = await execFileAsync('tar', [
        '-xzOf',
        tarball,
        'package/package.json',
      ]);
      const packageJson = JSON.parse(packageJsonText) as {
        repository: unknown;
        publishConfig: unknown;
      };
      expect(packageJson.repository).toEqual({
        type: 'git',
        url: 'git+https://github.com/speckify-pack-e2e/pet-shelter.git',
      });
      expect(packageJson.publishConfig).toEqual({
        registry: 'https://npm.pkg.github.com',
        access: 'public',
      });

      await writeFile(tarball, Buffer.concat([bytes, Buffer.from('tampered')]));
      await expect(
        execFileAsync(
          process.execPath,
          [cliPath, 'publish', '--from-pack', '-c', 'speckify.yaml'],
          {
            cwd: workDir,
            env,
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('changed since it was packed') as unknown,
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 180_000);

  it('refuses --pack-only together with --from-pack, and --attestation without --from-pack', async () => {
    await execFileAsync('npm', ['run', 'build'], { cwd: repoRoot });

    await expect(
      execFileAsync(process.execPath, [cliPath, 'publish', '--pack-only', '--from-pack']),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('cannot be used together') as unknown,
    });
    await expect(
      execFileAsync(process.execPath, [cliPath, 'publish', '--attestation', 'bundle.jsonl']),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('only applies with --from-pack') as unknown,
    });
  }, 60_000);

  it.skipIf(!uvAvailable)(
    'builds both languages with the default --out, invoked from the config dir, with no nested-path failure',
    async () => {
      await execFileAsync('npm', ['run', 'build'], { cwd: repoRoot });

      const workDir = await mkdtemp(join(tmpdir(), 'speckify-built-cli-default-out-'));
      try {
        await cp(join(exampleDir, 'openapi.yaml'), join(workDir, 'openapi.yaml'));

        const speckifyYaml = [
          'contracts:',
          '  - name: pet-shelter-default-out-e2e',
          '    spec: ./openapi.yaml',
          '    typescript:',
          '      package: "@speckify-default-out-e2e/pet-shelter"',
          '      client: true',
          '      server: true',
          '    python:',
          '      package: speckify-default-out-e2e-pet-shelter',
          '      client: true',
          '      server: true',
          '',
          'publish:',
          '  githubPackages:',
          '    owner: speckify-default-out-e2e',
          '',
        ].join('\n');
        await writeFile(join(workDir, 'speckify.yaml'), speckifyYaml, 'utf8');

        // Deliberately no `-o`: this exercises `DEFAULT_BUILD_OUT_DIR`
        // ('.speckify/out', a relative path) resolved against the config
        // dir, from a cwd that is that same config dir. A prior bug left
        // the default unresolved, so `uv build`'s own cwd (the generated
        // project dir, itself under the relative default) re-resolved the
        // relative --out-dir a second time underneath itself, and the
        // wheel/sdist never landed where Speckify looked for them.
        await execFileAsync(process.execPath, [cliPath, 'build', '-c', 'speckify.yaml'], {
          cwd: workDir,
          env: { ...process.env, GITHUB_TOKEN: '' },
        });

        const wheelDir = join(
          workDir,
          '.speckify',
          'out',
          'pet-shelter-default-out-e2e',
          'python',
          'dist',
        );
        const distEntries = await readdir(wheelDir);
        expect(distEntries.some((name) => name.endsWith('.whl'))).toBe(true);
        expect(distEntries.some((name) => name.endsWith('.tar.gz'))).toBe(true);

        const tsDistEntries = await readdir(
          join(workDir, '.speckify', 'out', 'pet-shelter-default-out-e2e', 'typescript', 'dist'),
        );
        expect(tsDistEntries.length).toBeGreaterThan(0);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it("runs when invoked through a symlink, as npm's own node_modules/.bin entry always is", async () => {
    await execFileAsync('npm', ['run', 'build'], { cwd: repoRoot });

    const binDir = await mkdtemp(join(tmpdir(), 'speckify-built-cli-symlink-'));
    try {
      const linkPath = join(binDir, 'speckify');
      // Mirrors exactly how npm links a package's `bin` entry:
      // node_modules/.bin/speckify -> ../speckify/dist/cli.js. Node
      // resolves import.meta.url through the symlink to the real file, but
      // process.argv[1] stays the symlink path the user (or npm) invoked --
      // comparing them without resolving both the same way makes the
      // "am I the entry point" check fail silently, so the CLI parses no
      // args and exits 0 having done nothing.
      await symlink(cliPath, linkPath);

      const { stdout } = await execFileAsync(process.execPath, [linkPath, '--help']);
      expect(stdout).toContain('speckify');
      expect(stdout).toContain('Bundle, version and publish an OpenAPI contract.');
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * `config get` exists so action.yml can read the caller's npm owner through
 * parsed, validated config instead of grep-ing the YAML text: a naive
 * `grep 'owner:' | sed ...` reads an inline comment
 * ("owner: acme  # note to self") straight into the scope, since grep/sed
 * know nothing about YAML comment syntax. No network needed, so this runs
 * unconditionally.
 */
describe('the built CLI (node dist/cli.js config get)', () => {
  it('prints the configured owner, ignoring a trailing YAML comment a grep-based reader would have swallowed', async () => {
    await execFileAsync('npm', ['run', 'build'], { cwd: repoRoot });

    const workDir = await mkdtemp(join(tmpdir(), 'speckify-built-cli-config-get-'));
    try {
      const speckifyYaml = [
        'contracts:',
        '  - name: pet-shelter',
        '    spec: ./openapi.yaml',
        'publish:',
        '  githubPackages:',
        '    owner: acme  # trailing comment a grep/sed reader would leak into the scope',
        '',
      ].join('\n');
      await writeFile(join(workDir, 'speckify.yaml'), speckifyYaml, 'utf8');

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        'config',
        'get',
        'publish.githubPackages.owner',
        '-c',
        join(workDir, 'speckify.yaml'),
      ]);

      expect(stdout.trim()).toBe('acme');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('exits non-zero and prints nothing to stdout for a path with no string value', async () => {
    await execFileAsync('npm', ['run', 'build'], { cwd: repoRoot });

    const workDir = await mkdtemp(join(tmpdir(), 'speckify-built-cli-config-get-missing-'));
    try {
      const speckifyYaml = [
        'contracts:',
        '  - name: pet-shelter',
        '    spec: ./openapi.yaml',
        'publish:',
        '  githubPackages:',
        '    owner: acme',
        '',
      ].join('\n');
      await writeFile(join(workDir, 'speckify.yaml'), speckifyYaml, 'utf8');

      await expect(
        execFileAsync(process.execPath, [
          cliPath,
          'config',
          'get',
          'publish.somethingUnset',
          '-c',
          join(workDir, 'speckify.yaml'),
        ]),
      ).rejects.toMatchObject({ code: 1, stdout: '' });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// Kept in this file, not its own: every test here rebuilds `dist/`, and two
// files doing that at once let one run a half-written build.

// What stands between a packed tarball and the registry is the CLI's
// `publish --from-pack`. These tests run the *built* CLI, as the composite
// action does, with an `npm` on PATH that records any `npm publish` it is
// asked to run and a `gh` that answers as the test says. A refusal must leave
// the `npm` record absent: nothing was published, not merely an error shown.
// No registry is reached, because every refusal comes before the first
// registry call, so these run with no network.

const stat256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface Packed {
  name: string;
  bytes: Buffer;
}

interface Workspace {
  dir: string;
  env: NodeJS.ProcessEnv;
  /** Writes a file into the workspace and returns its path. */
  write: (name: string, text: string) => Promise<string>;
  /** True when the stub `npm` was run at all. */
  npmWasRun: () => Promise<boolean>;
  /** The argument lines the stub `gh` was run with. */
  ghCalls: () => Promise<string[]>;
}

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeAll(async () => {
  await execFileAsync('npm', ['run', 'build'], { cwd: repoRoot });
}, 120_000);

/** A statement bundle as `actions/attest-build-provenance` writes it, naming the given digests. */
function bundleOf(digests: string[]): string {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: digests.map((digest, index) => ({
      name: `file-${String(index)}.tgz`,
      digest: { sha256: digest },
    })),
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {},
  };
  return JSON.stringify({
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    dsseEnvelope: {
      payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
      payloadType: 'application/vnd.in-toto+json',
      signatures: [],
    },
  });
}

/** A `--format json` result of `gh attestation verify`, signed by `repo` for `sha256`. */
function verifiedResult(sha256: string, repo: string): string {
  const commit = 'd'.repeat(40);
  return JSON.stringify([
    {
      verificationResult: {
        statement: {
          predicateType: 'https://slsa.dev/provenance/v1',
          subject: [{ digest: { sha256 } }],
        },
        signature: {
          certificate: {
            issuer: 'https://token.actions.githubusercontent.com',
            githubWorkflowRepository: repo,
            sourceRepositoryURI: `https://github.com/${repo}`,
            sourceRepositoryRef: 'refs/heads/main',
            subjectAlternativeName: `https://github.com/${repo}/.github/workflows/release.yml@refs/heads/main`,
            githubWorkflowRef: 'refs/heads/main',
            runnerEnvironment: 'github-hosted',
            sourceRepositoryDigest: commit,
            buildSignerDigest: commit,
          },
        },
      },
    },
  ]);
}

async function workspaceWith(tarballs: Packed[]): Promise<Workspace> {
  // Through realpath, because the temp directory is a symlink on macOS.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'speckify-attestation-gate-')));
  workspaces.push(dir);

  const write = async (name: string, text: string): Promise<string> => {
    const file = join(dir, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
    return file;
  };

  await write(
    'speckify.yaml',
    [
      'contracts:',
      '  - name: orders',
      '    spec: ./openapi.yaml',
      '    typescript:',
      '      package: "@acme-gate/orders"',
      '      client: true',
      '',
      'publish:',
      '  githubPackages:',
      '    owner: acme-gate',
      '',
    ].join('\n'),
  );

  const packDir = join(dir, '.speckify', 'pack');
  await mkdir(packDir, { recursive: true });
  for (const tarball of tarballs) {
    await writeFile(join(packDir, tarball.name), tarball.bytes);
  }
  await write(
    '.speckify/pack/speckify-pack.json',
    JSON.stringify({
      schemaVersion: 1,
      contracts: [
        {
          name: 'orders',
          version: '1.0.0',
          changelog: '',
          bundledSpec: '{}',
          targets: tarballs.map((tarball, index) => ({
            kind: 'npm',
            label: `orders-typescript-${String(index)}`,
            packageName: '@acme-gate/orders',
            version: '1.0.0',
            tarball: tarball.name,
            sha256: stat256(tarball.bytes),
          })),
        },
      ],
    }),
  );

  const binDir = join(dir, 'bin');
  await mkdir(binDir);
  const npmRecord = join(dir, 'npm-was-run');
  const ghRecord = join(dir, 'gh-calls');
  const ghAnswer = join(dir, 'gh-answer.json');
  const stub = async (name: string, lines: string[]): Promise<void> => {
    const file = join(binDir, name);
    await writeFile(file, ['#!/bin/sh', ...lines, ''].join('\n'));
    await chmod(file, 0o755);
  };
  await stub('npm', [`echo "$@" >> '${npmRecord}'`, 'exit 0']);
  await stub('gh', [`echo "$@" >> '${ghRecord}'`, `cat '${ghAnswer}'`, 'exit 0']);

  return {
    dir,
    write,
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      GITHUB_TOKEN: 'test-token',
      NODE_AUTH_TOKEN: 'test-token',
      GH_TOKEN: 'test-token',
    },
    npmWasRun: () =>
      stat(npmRecord).then(
        () => true,
        () => false,
      ),
    ghCalls: () =>
      readFile(ghRecord, 'utf8').then(
        (text) => text.split('\n').filter((line) => line !== ''),
        () => [],
      ),
  };
}

async function publishFromPack(
  workspace: Workspace,
  extra: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, 'publish', '--from-pack', '-c', 'speckify.yaml', ...extra],
      { cwd: workspace.dir, env: workspace.env },
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
  }
}

const TARBALL: Packed = {
  name: 'acme-gate-orders-1.0.0.tgz',
  bytes: Buffer.from('the packed bytes'),
};
const OTHER: Packed = {
  name: 'acme-gate-other-1.0.0.tgz',
  bytes: Buffer.from('other packed bytes'),
};

describe('the built CLI refuses to publish a tarball its attestation does not cover', () => {
  it('refuses a bundle that attests a different digest, and publishes nothing', async () => {
    const workspace = await workspaceWith([TARBALL]);
    const bundle = await workspace.write('attestation.jsonl', bundleOf(['0'.repeat(64)]));

    const result = await publishFromPack(workspace, ['--attestation', bundle]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('is not in the attestation');
    expect(result.stderr).toContain(`sha256:${stat256(TARBALL.bytes)}`);
    expect(await workspace.npmWasRun()).toBe(false);
  }, 60_000);

  it('refuses when one of two tarballs is covered and the other is not, and publishes neither', async () => {
    const workspace = await workspaceWith([TARBALL, OTHER]);
    const bundle = await workspace.write('attestation.jsonl', bundleOf([stat256(TARBALL.bytes)]));

    const result = await publishFromPack(workspace, ['--attestation', bundle]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('is not in the attestation');
    expect(result.stderr).toContain(`sha256:${stat256(OTHER.bytes)}`);
    expect(await workspace.npmWasRun()).toBe(false);
  }, 60_000);

  it('refuses a tarball with no attestation at all when one is required, and publishes nothing', async () => {
    const workspace = await workspaceWith([TARBALL]);

    const result = await publishFromPack(workspace, ['--require-attestation']);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('an attestation is required and no attestation was given');
    expect(await workspace.npmWasRun()).toBe(false);
  }, 60_000);

  it('refuses a bundle that is not an attestation, and publishes nothing', async () => {
    const workspace = await workspaceWith([TARBALL]);
    const bundle = await workspace.write('attestation.jsonl', 'not json');

    const result = await publishFromPack(workspace, ['--attestation', bundle]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('the attestation file is not JSON');
    expect(await workspace.npmWasRun()).toBe(false);
  }, 60_000);
});

describe('the built CLI verifies who signed, when told the identity', () => {
  const identity = [
    '--attestation-repo',
    'acme-gate/orders',
    '--attestation-signer-workflow',
    'acme-gate/orders/.github/workflows/release.yml',
    '--attestation-source-ref',
    'refs/heads/main',
  ];

  it('runs gh attestation verify bound to that identity, and refuses a signer that is someone else', async () => {
    const workspace = await workspaceWith([TARBALL]);
    const sha256 = stat256(TARBALL.bytes);
    const bundle = await workspace.write('attestation.jsonl', bundleOf([sha256]));
    await workspace.write('gh-answer.json', verifiedResult(sha256, 'someone-else/orders'));

    const result = await publishFromPack(workspace, [
      '--require-attestation',
      '--attestation',
      bundle,
      ...identity,
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      'workflow repository is "someone-else/orders", not acme-gate/orders',
    );
    expect(await workspace.npmWasRun()).toBe(false);

    const [call] = await workspace.ghCalls();
    expect(call).toContain('attestation verify');
    expect(call).toContain(join(workspace.dir, '.speckify', 'pack', TARBALL.name));
    expect(call).toContain('--repo acme-gate/orders');
    expect(call).toContain('--signer-workflow acme-gate/orders/.github/workflows/release.yml');
    expect(call).toContain('--source-ref refs/heads/main');
  }, 60_000);

  it('refuses all three identity flags unless they come together', async () => {
    const workspace = await workspaceWith([TARBALL]);

    const result = await publishFromPack(workspace, ['--attestation-repo', 'acme-gate/orders']);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('must all be given together');
    expect(await workspace.npmWasRun()).toBe(false);
    expect(await workspace.ghCalls()).toEqual([]);
  }, 60_000);

  it('refuses the identity flags without --from-pack', async () => {
    const workspace = await workspaceWith([TARBALL]);
    try {
      await execFileAsync(
        process.execPath,
        [cliPath, 'publish', '-c', 'speckify.yaml', '--require-attestation'],
        { cwd: workspace.dir, env: workspace.env },
      );
      throw new Error('the CLI should have refused');
    } catch (error) {
      expect((error as { stderr?: string }).stderr).toContain(
        '--require-attestation only applies with --from-pack',
      );
    }
    expect(await workspace.npmWasRun()).toBe(false);
  }, 60_000);
});

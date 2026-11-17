import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliPath = join(repoRoot, 'dist', 'cli.js');

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

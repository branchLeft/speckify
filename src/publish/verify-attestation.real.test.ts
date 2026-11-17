import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { PublishError } from './errors.js';
import { verifyTarballAttestation, type AttestationIdentity } from './verify-attestation.js';

// The fixture is the unedited output of
//
//   gh attestation verify gh_2.104.0_linux_amd64.tar.gz --repo cli/cli --format json
//
// run read-only against the real release asset of github.com/cli/cli v2.104.0
// (built by its `deployment.yml` workflow, attested with
// actions/attest-build-provenance), after downloading that asset into an empty
// directory. It is public data: the asset, its attestation and the Sigstore
// certificate fields are all public on github.com. Unlike the hand-built
// results in verify-attestation.test.ts, it shows the field names `gh`
// really prints, which is what the verifier's certificate reader depends on.

const FIXTURE = new URL('./fixtures/gh-attestation-verify.cli-v2.104.0.json', import.meta.url);

/** The sha-256 of gh_2.104.0_linux_amd64.tar.gz, one of the fixture's 21 subjects. */
const TARBALL_SHA256 = '98cb101ad87dbbd3f6b2f2bfcbd43197ccd07643140121d8a9cfaa91eadbc24e';

const identity: AttestationIdentity = {
  repo: 'cli/cli',
  signerWorkflow: 'cli/cli/.github/workflows/deployment.yml',
  sourceRef: 'refs/heads/trunk',
};

type Json = Record<string, unknown>;

async function realOutput(): Promise<Json[]> {
  return JSON.parse(await readFile(FIXTURE, 'utf8')) as Json[];
}

/** Follows `path` into `value`; every step must exist. */
function at(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || !(key in current)) {
      throw new Error(`the real output has no ${path.join('.')} (stopped at ${key})`);
    }
    current = (current as Json)[key];
  }
  return current;
}

async function verifyOutput(
  output: unknown,
  who: AttestationIdentity = identity,
  sha256: string = TARBALL_SHA256,
): Promise<void> {
  await verifyTarballAttestation({
    tarballPath: '/packs/gh_2.104.0_linux_amd64.tar.gz',
    sha256,
    identity: who,
    runProcess: vi.fn().mockResolvedValue({ stdout: JSON.stringify(output), stderr: '' }),
    sleep: vi.fn().mockResolvedValue(undefined),
  });
}

const CERTIFICATE = ['verificationResult', 'signature', 'certificate'] as const;
const STATEMENT = ['verificationResult', 'statement'] as const;

/** Each field the verifier reads, with what the real output holds there. */
const BOUND_FIELDS: readonly { path: readonly string[]; real: unknown }[] = [
  { path: [...CERTIFICATE, 'issuer'], real: 'https://token.actions.githubusercontent.com' },
  { path: [...CERTIFICATE, 'githubWorkflowRepository'], real: 'cli/cli' },
  { path: [...CERTIFICATE, 'sourceRepositoryURI'], real: 'https://github.com/cli/cli' },
  { path: [...CERTIFICATE, 'sourceRepositoryRef'], real: 'refs/heads/trunk' },
  {
    path: [...CERTIFICATE, 'subjectAlternativeName'],
    real: 'https://github.com/cli/cli/.github/workflows/deployment.yml@refs/heads/trunk',
  },
  { path: [...CERTIFICATE, 'githubWorkflowRef'], real: 'refs/heads/trunk' },
  { path: [...CERTIFICATE, 'runnerEnvironment'], real: 'github-hosted' },
  { path: [...STATEMENT, 'predicateType'], real: 'https://slsa.dev/provenance/v1' },
];

describe('the certificate reader, over a real `gh attestation verify` result', () => {
  it('finds every field it binds, under the names gh really prints', async () => {
    const [entry] = await realOutput();
    for (const { path, real } of BOUND_FIELDS) {
      expect(at(entry, path), path.join('.')).toBe(real);
    }
    const commit = at(entry, [...CERTIFICATE, 'sourceRepositoryDigest']);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(at(entry, [...CERTIFICATE, 'buildSignerDigest'])).toBe(commit);
    const subjects = at(entry, [...STATEMENT, 'subject']) as { digest: { sha256: string } }[];
    expect(subjects.map((subject) => subject.digest.sha256)).toContain(TARBALL_SHA256);
  });

  it('accepts the real result for the identity it was made under', async () => {
    await expect(verifyOutput(await realOutput())).resolves.toBeUndefined();
  });

  it.each(BOUND_FIELDS.map((field) => [field.path.at(-1) ?? '', field.path] as const))(
    'refuses once %s no longer says what it said',
    async (_name, path) => {
      const output = await realOutput();
      const parent = at(output[0], path.slice(0, -1)) as Json;
      parent[path.at(-1) ?? ''] = 'tampered';
      await expect(verifyOutput(output)).rejects.toBeInstanceOf(PublishError);
    },
  );

  it.each(BOUND_FIELDS.map((field) => [field.path.at(-1) ?? '', field.path] as const))(
    'refuses once %s is missing',
    async (_name, path) => {
      const output = await realOutput();
      const parent = at(output[0], path.slice(0, -1)) as Json;
      // A field the reader never saw is not one it may skip.
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete parent[path.at(-1) ?? ''];
      await expect(verifyOutput(output)).rejects.toBeInstanceOf(PublishError);
    },
  );

  it('refuses a commit that is not a full sha, and a signer commit that differs from the source commit', async () => {
    const notASha = await realOutput();
    (at(notASha[0], CERTIFICATE) as Json).sourceRepositoryDigest = 'trunk';
    await expect(verifyOutput(notASha)).rejects.toThrow(/source commit/);

    const differs = await realOutput();
    (at(differs[0], CERTIFICATE) as Json).buildSignerDigest = 'f'.repeat(40);
    await expect(verifyOutput(differs)).rejects.toThrow(/signer commit differs/);
  });

  it('refuses when the tarball digest is not among the attested subjects', async () => {
    await expect(verifyOutput(await realOutput(), identity, '0'.repeat(64))).rejects.toThrow(
      /do not include this tarball's sha256/,
    );
  });

  it.each([
    ['repository', { ...identity, repo: 'cli/other' }, /workflow repository/],
    [
      'signer workflow',
      { ...identity, signerWorkflow: 'cli/cli/.github/workflows/other.yml' },
      /signer identity/,
    ],
    ['ref', { ...identity, sourceRef: 'refs/heads/main' }, /source ref/],
  ] as const)(
    'refuses the real result when the caller states a different %s',
    async (_name, wrong, message) => {
      await expect(verifyOutput(await realOutput(), wrong)).rejects.toThrow(message);
    },
  );

  it('refuses the real branch result when the caller bound a tag ref', async () => {
    await expect(
      verifyOutput(await realOutput(), { ...identity, sourceRef: 'refs/tags/v2.104.0' }),
    ).rejects.toBeInstanceOf(PublishError);
  });
});

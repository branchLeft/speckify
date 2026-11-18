import { describe, expect, it, vi } from 'vitest';

import { PublishError } from './errors.js';
import {
  ATTESTATION_OIDC_ISSUER,
  SLSA_PROVENANCE_PREDICATE,
  verifyTarballAttestation,
  type AttestationIdentity,
} from './verify-attestation.js';

const SHA = 'a'.repeat(64);
const COMMIT = 'c'.repeat(40);

const identity: AttestationIdentity = {
  repo: 'acme/orders',
  signerWorkflow: 'acme/orders/.github/workflows/speckify.yml',
  sourceRef: 'refs/heads/main',
};

/** One entry of `gh attestation verify --format json`, shaped as gh prints it. */
function result(
  overrides: Record<string, unknown> = {},
  statement: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    verificationResult: {
      statement: {
        predicateType: SLSA_PROVENANCE_PREDICATE,
        subject: [{ name: 'a.tgz', digest: { sha256: SHA } }],
        ...statement,
      },
      signature: {
        certificate: {
          issuer: ATTESTATION_OIDC_ISSUER,
          githubWorkflowRepository: identity.repo,
          sourceRepositoryURI: `https://github.com/${identity.repo}`,
          sourceRepositoryRef: identity.sourceRef,
          subjectAlternativeName: `https://github.com/${identity.signerWorkflow}@${identity.sourceRef}`,
          githubWorkflowRef: identity.sourceRef,
          runnerEnvironment: 'github-hosted',
          sourceRepositoryDigest: COMMIT,
          buildSignerDigest: COMMIT,
          ...overrides,
        },
      },
    },
  };
}

function runnerPrinting(...outputs: unknown[]): ReturnType<typeof vi.fn> {
  const run = vi.fn();
  for (const output of outputs) {
    run.mockResolvedValueOnce({ stdout: JSON.stringify(output), stderr: '' });
  }
  return run;
}

const noSleep = vi.fn().mockResolvedValue(undefined);

function verify(
  runProcess: ReturnType<typeof vi.fn>,
  extra: { attempts?: number; sleep?: (seconds: number) => Promise<void> } = {},
): Promise<void> {
  return verifyTarballAttestation({
    tarballPath: '/packs/acme-orders-1.0.0.tgz',
    sha256: SHA,
    identity,
    runProcess,
    sleep: noSleep,
    ...extra,
  });
}

describe('verifyTarballAttestation', () => {
  it('asks gh to verify the signature against the repository, signer workflow and ref', async () => {
    const run = runnerPrinting([result()]);
    await verify(run);

    expect(run).toHaveBeenCalledWith('gh', [
      'attestation',
      'verify',
      '/packs/acme-orders-1.0.0.tgz',
      '--repo',
      'acme/orders',
      '--signer-workflow',
      'acme/orders/.github/workflows/speckify.yml',
      '--cert-oidc-issuer',
      ATTESTATION_OIDC_ISSUER,
      '--predicate-type',
      SLSA_PROVENANCE_PREDICATE,
      '--deny-self-hosted-runners',
      '--source-ref',
      'refs/heads/main',
      '--format',
      'json',
    ]);
  });

  it('accepts when any one of several results is for exactly this identity and digest', async () => {
    const run = runnerPrinting([result({ githubWorkflowRepository: 'other/repo' }), result()]);
    await expect(verify(run)).resolves.toBeUndefined();
  });

  // gh enforces the flags it was given; each of these reads the same fact
  // again from the certificate, so a gh that is wrong, old or replaced still
  // cannot make a tarball signed by the wrong identity pass.
  it.each([
    ['the issuer', { issuer: 'https://evil.example' }, /issuer/],
    ['the workflow repository', { githubWorkflowRepository: 'other/repo' }, /workflow repository/],
    [
      'the source repository',
      { sourceRepositoryURI: 'https://github.com/other/repo' },
      /source repository/,
    ],
    ['the source ref', { sourceRepositoryRef: 'refs/heads/feature' }, /source ref/],
    [
      'the signer identity',
      {
        subjectAlternativeName:
          'https://github.com/acme/orders/.github/workflows/other.yml@refs/heads/main',
      },
      /signer identity/,
    ],
    ['the workflow ref', { githubWorkflowRef: 'refs/heads/feature' }, /workflow ref/],
    ['a self-hosted runner', { runnerEnvironment: 'self-hosted' }, /runner/],
    ['a source commit that is not 40 hex', { sourceRepositoryDigest: 'abc' }, /source commit/],
    ['a signer commit that differs', { buildSignerDigest: 'd'.repeat(40) }, /signer commit/],
  ])('refuses a result with the wrong %s', async (_label, overrides, pattern) => {
    const run = runnerPrinting([result(overrides)]);
    await expect(verify(run)).rejects.toThrow(pattern);
    // A wrong identity is an answer, not a fault: it is not retried.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses a result whose predicate is not SLSA provenance', async () => {
    const run = runnerPrinting([result({}, { predicateType: 'https://example.com/other' })]);
    await expect(verify(run)).rejects.toThrow(/predicate type/);
  });

  it('refuses a result whose subjects do not include this tarball digest', async () => {
    const run = runnerPrinting([result({}, { subject: [{ digest: { sha256: 'b'.repeat(64) } }] })]);
    await expect(verify(run)).rejects.toThrow(/do not include this tarball's sha256/);
  });

  it.each([
    ['an empty list', []],
    ['an object, not a list', {}],
    ['a result with no verificationResult', [{}]],
    ['a result with no certificate', [{ verificationResult: { statement: {} } }]],
  ])('refuses gh output that is %s', async (_label, output) => {
    const run = runnerPrinting(output);
    await expect(verify(run)).rejects.toThrow(PublishError);
  });

  it('refuses gh output that is not JSON', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' });
    await expect(verify(run)).rejects.toThrow(/not JSON/);
  });

  it('retries a gh failure (the attestation can take a moment to reach the API), then succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 404: no attestations found'))
      .mockRejectedValueOnce(new Error('HTTP 404: no attestations found'))
      .mockResolvedValueOnce({ stdout: JSON.stringify([result()]), stderr: '' });

    await expect(verify(run, { sleep })).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledTimes(3);
    // Each wait is one pause longer than the last.
    expect(sleep.mock.calls.map((call) => call[0] as number)).toEqual([12, 24]);
  });

  it('fails after the last attempt, naming gh error', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockRejectedValue(new Error('HTTP 404: no attestations found'));

    await expect(verify(run, { attempts: 3, sleep })).rejects.toThrow(
      /gh attestation verify failed after 3 attempts.*no attestations found/s,
    );
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry when gh is not installed', async () => {
    const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    const run = vi.fn().mockRejectedValue(missing);
    await expect(verify(run)).rejects.toThrow(/gh is not installed/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses an identity that is not owner/repo and a workflow outside .github/workflows', async () => {
    const run = vi.fn();
    await expect(
      verifyTarballAttestation({
        tarballPath: '/t.tgz',
        sha256: SHA,
        identity: { ...identity, repo: 'no-slash' },
        runProcess: run,
      }),
    ).rejects.toThrow(PublishError);
    await expect(
      verifyTarballAttestation({
        tarballPath: '/t.tgz',
        sha256: SHA,
        identity: { ...identity, signerWorkflow: 'acme/orders/scripts/x.yml' },
        runProcess: run,
      }),
    ).rejects.toThrow(PublishError);
    await expect(
      verifyTarballAttestation({
        tarballPath: '/t.tgz',
        sha256: SHA,
        identity: { ...identity, sourceRef: 'main' },
        runProcess: run,
      }),
    ).rejects.toThrow(PublishError);
    expect(run).not.toHaveBeenCalled();
  });
});

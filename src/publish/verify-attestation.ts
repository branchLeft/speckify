import { z } from 'zod';

import { githubRepositorySchema } from '../config/index.js';
import { PublishError } from './errors.js';
import { defaultProcessRunner } from './process-runner.js';
import type { ProcessRunner } from './types.js';

/** The issuer every GitHub Actions attestation certificate is issued under. */
export const ATTESTATION_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
/** The predicate `actions/attest-build-provenance` writes. */
export const SLSA_PROVENANCE_PREDICATE = 'https://slsa.dev/provenance/v1';

const GITHUB_HOSTED = 'github-hosted';
const COMMIT = /^[0-9a-f]{40}$/;

/** Who may have signed a tarball's attestation: a literal the caller states, never read from the attestation. */
export interface AttestationIdentity {
  /** The repository that owns the workflow, `owner/repo`. */
  repo: string;
  /** The workflow that signed, `owner/repo/.github/workflows/<file>.yml`. */
  signerWorkflow: string;
  /** The exact ref the signing run was on, `refs/heads/...` or `refs/tags/...`. */
  sourceRef: string;
}

const identitySchema = z.object({
  repo: githubRepositorySchema,
  signerWorkflow: z
    .string()
    .regex(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/,
      'must be owner/repo/.github/workflows/<file>.yml',
    ),
  sourceRef: z
    .string()
    .regex(/^refs\/(heads|tags)\/\S+$/, 'must be a refs/heads/ or refs/tags/ ref'),
});

export interface VerifyTarballAttestationOptions {
  tarballPath: string;
  /** The tarball's sha-256 (hex), which one attested subject must carry. */
  sha256: string;
  identity: AttestationIdentity;
  runProcess?: ProcessRunner | undefined;
  /** Waits this many seconds; replaced in tests. */
  sleep?: ((seconds: number) => Promise<void>) | undefined;
  /** How many times `gh` is tried. @default 5 */
  attempts?: number | undefined;
  /** The wait after the first failure; each later wait is this much longer again. @default 12 */
  pauseSeconds?: number | undefined;
}

/** One entry of `gh attestation verify --format json`: the certificate and statement it verified. */
const resultSchema = z.object({
  verificationResult: z.object({
    statement: z.object({
      predicateType: z.unknown(),
      subject: z.unknown(),
    }),
    signature: z.object({ certificate: z.record(z.string(), z.unknown()) }),
  }),
});

/** Every way one verified result is not an attestation by exactly `identity` of exactly `sha256`. */
function judge(result: unknown, sha256: string, identity: AttestationIdentity): string[] {
  const parsed = resultSchema.safeParse(result);
  if (!parsed.success) {
    return ['a result has no certificate or statement'];
  }
  const { statement, signature } = parsed.data.verificationResult;
  const certificate = signature.certificate;
  const problems: string[] = [];

  if (statement.predicateType !== SLSA_PROVENANCE_PREDICATE) {
    problems.push(
      `predicate type is ${JSON.stringify(statement.predicateType)}, not ${SLSA_PROVENANCE_PREDICATE}`,
    );
  }
  const subjects = Array.isArray(statement.subject) ? (statement.subject as unknown[]) : [];
  const attested = subjects.flatMap((subject) => {
    const digest = (subject as { digest?: { sha256?: unknown } } | null)?.digest?.sha256;
    return typeof digest === 'string' ? [digest.toLowerCase()] : [];
  });
  if (!attested.includes(sha256)) {
    problems.push(
      `the attested subject digests [${attested.join(', ')}] do not include this tarball's sha256 ${sha256}`,
    );
  }

  const checks: [label: string, found: unknown, expected: string][] = [
    ['issuer', certificate.issuer, ATTESTATION_OIDC_ISSUER],
    ['workflow repository', certificate.githubWorkflowRepository, identity.repo],
    ['source repository', certificate.sourceRepositoryURI, `https://github.com/${identity.repo}`],
    ['source ref', certificate.sourceRepositoryRef, identity.sourceRef],
    [
      'signer identity',
      certificate.subjectAlternativeName,
      `https://github.com/${identity.signerWorkflow}@${identity.sourceRef}`,
    ],
    ['workflow ref', certificate.githubWorkflowRef, identity.sourceRef],
    ['runner', certificate.runnerEnvironment, GITHUB_HOSTED],
  ];
  for (const [label, found, expected] of checks) {
    if (found !== expected) {
      problems.push(`${label} is ${JSON.stringify(found)}, not ${expected}`);
    }
  }

  const commit = certificate.sourceRepositoryDigest;
  if (typeof commit !== 'string' || !COMMIT.test(commit)) {
    problems.push(`source commit is ${JSON.stringify(commit)}, not a 40-hex sha`);
  } else if (certificate.buildSignerDigest !== commit) {
    problems.push('signer commit differs from the source commit');
  }
  return problems;
}

const realSleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Proves a tarball was attested by exactly the stated identity, before it is
 * published. It runs `gh attestation verify`, which checks the Sigstore
 * signature and looks the attestation up on GitHub, bound to the repository,
 * signer workflow, source ref, OIDC issuer and SLSA provenance predicate and
 * refusing self-hosted runners. It then reads the same facts again from the
 * certificate it returned, so a `gh` that ignored a flag still cannot pass a
 * wrong identity, and requires the tarball's own digest among the subjects.
 *
 * A `gh` failure is retried (the attestation can take a moment to reach the
 * API); a result that names the wrong identity or digest is an answer, and is
 * not. Anything unexpected is a refusal: there is no skip path.
 *
 * @throws {PublishError} unless the tarball verifies for exactly `identity`.
 */
export async function verifyTarballAttestation(
  options: VerifyTarballAttestationOptions,
): Promise<void> {
  const identity = identitySchema.safeParse(options.identity);
  if (!identity.success) {
    throw new PublishError(
      `invalid attestation identity: ${identity.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
    );
  }

  const runProcess = options.runProcess ?? defaultProcessRunner;
  const sleep = options.sleep ?? realSleep;
  const attempts = options.attempts ?? 5;
  const pauseSeconds = options.pauseSeconds ?? 12;
  const args = [
    'attestation',
    'verify',
    options.tarballPath,
    '--repo',
    identity.data.repo,
    '--signer-workflow',
    identity.data.signerWorkflow,
    '--cert-oidc-issuer',
    ATTESTATION_OIDC_ISSUER,
    '--predicate-type',
    SLSA_PROVENANCE_PREDICATE,
    '--deny-self-hosted-runners',
    '--source-ref',
    identity.data.sourceRef,
    '--format',
    'json',
  ];

  let stdout = '';
  let lastFailure = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      ({ stdout } = await runProcess('gh', args));
      lastFailure = '';
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') {
        throw new PublishError(
          'gh is not installed, so the attestation cannot be verified; nothing was published',
        );
      }
      lastFailure = reasonOf(error);
      if (attempt < attempts) {
        await sleep(pauseSeconds * attempt);
      }
    }
  }
  if (lastFailure !== '') {
    throw new PublishError(
      `gh attestation verify failed after ${String(attempts)} attempts for ${options.tarballPath}: ${lastFailure.slice(0, 300)}`,
    );
  }

  let results: unknown;
  try {
    results = JSON.parse(stdout);
  } catch {
    throw new PublishError('gh attestation verify exited 0 but its output is not JSON');
  }
  if (!Array.isArray(results) || results.length === 0) {
    throw new PublishError('gh attestation verify exited 0 but printed no result');
  }

  const allProblems = (results as unknown[]).map((result) =>
    judge(result, options.sha256, identity.data),
  );
  if (!allProblems.some((problems) => problems.length === 0)) {
    throw new PublishError(
      `${options.tarballPath} is not attested by ${identity.data.signerWorkflow}@${identity.data.sourceRef}: ${(allProblems[0] ?? []).join('; ')}`,
    );
  }
}

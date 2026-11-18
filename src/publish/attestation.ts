import { z } from 'zod';

import { PublishError } from './errors.js';

/** Just the part of a sigstore bundle that names what was attested. */
const bundleSchema = z.object({
  dsseEnvelope: z.object({ payload: z.string().min(1) }),
});

/** An in-toto statement: the subjects an attestation covers, each with its digests. */
const statementSchema = z.object({
  subject: z
    .array(z.object({ digest: z.record(z.string(), z.string()) }))
    .min(1, 'has no subjects'),
});

/** The bundles in `text`: one JSON document, or one per line (the action writes a line per attestation). */
function parseBundles(text: string): unknown[] {
  const whole = tryParseJson(text);
  if (whole !== undefined) {
    return [whole];
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const parsed = lines.map((line) => tryParseJson(line));
  if (parsed.length === 0 || parsed.includes(undefined)) {
    throw new PublishError('the attestation file is not JSON, or JSON lines');
  }
  return parsed;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function subjectDigests(bundle: unknown): string[] {
  const envelope = bundleSchema.safeParse(bundle);
  if (!envelope.success) {
    throw new PublishError('an attestation in the file has no DSSE envelope payload');
  }
  const statementJson = tryParseJson(
    Buffer.from(envelope.data.dsseEnvelope.payload, 'base64').toString('utf8'),
  );
  const statement = statementSchema.safeParse(statementJson);
  if (!statement.success) {
    throw new PublishError(
      `an attestation's statement is unreadable: ${statement.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return statement.data.subject.flatMap((subject) =>
    subject.digest.sha256 === undefined ? [] : [subject.digest.sha256.toLowerCase()],
  );
}

/**
 * Every sha-256 digest an attestation file covers, read from the subjects of
 * the in-toto statement each bundle carries. This reads what was signed, not
 * a file name: a tarball is attested only if its own digest is in here.
 *
 * @throws {PublishError} if the text is not a bundle (or lines of bundles)
 * whose statement lists subjects.
 */
export function attestedSha256s(text: string): Set<string> {
  return new Set(parseBundles(text).flatMap(subjectDigests));
}

/**
 * Refuses unless every digest is one that was attested, so the bytes about to
 * be published are the bytes that were signed.
 *
 * @throws {PublishError} naming each tarball whose digest is not attested.
 */
export function assertDigestsAttested(
  tarballs: readonly { label: string; sha256: string }[],
  attested: ReadonlySet<string>,
): void {
  const missing = tarballs.filter((tarball) => !attested.has(tarball.sha256));
  if (missing.length > 0) {
    throw new PublishError(
      `refusing to publish: the digest of ${missing.map((tarball) => `${tarball.label} (sha256:${tarball.sha256})`).join(', ')} is not in the attestation`,
    );
  }
}

import { describe, expect, it } from 'vitest';

import { assertDigestsAttested, attestedSha256s } from './attestation.js';
import { PublishError } from './errors.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

/** A sigstore bundle as `actions/attest-build-provenance` writes it, with the given subjects. */
function bundle(subjects: { name: string; digest: Record<string, string> }[]): string {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: subjects,
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

describe('attestedSha256s', () => {
  it('reads the sha-256 digest of every subject of one bundle', () => {
    const text = bundle([
      { name: 'a.tgz', digest: { sha256: DIGEST_A } },
      { name: 'b.tgz', digest: { sha256: DIGEST_B } },
    ]);
    expect(attestedSha256s(text)).toEqual(new Set([DIGEST_A, DIGEST_B]));
  });

  it('reads a file of one bundle per line, as the action writes several attestations', () => {
    const text = [
      bundle([{ name: 'a.tgz', digest: { sha256: DIGEST_A } }]),
      '',
      bundle([{ name: 'b.tgz', digest: { sha256: DIGEST_B } }]),
      '',
    ].join('\n');
    expect(attestedSha256s(text)).toEqual(new Set([DIGEST_A, DIGEST_B]));
  });

  it('reads one bundle written over several lines', () => {
    const text = JSON.stringify(
      JSON.parse(bundle([{ name: 'a', digest: { sha256: DIGEST_A } }])),
      null,
      2,
    );
    expect(attestedSha256s(text)).toEqual(new Set([DIGEST_A]));
  });

  it('lower-cases a digest, and ignores a subject carrying no sha-256', () => {
    const text = bundle([
      { name: 'a.tgz', digest: { sha256: DIGEST_A.toUpperCase() } },
      { name: 'b.tgz', digest: { sha512: 'f'.repeat(128) } },
    ]);
    expect(attestedSha256s(text)).toEqual(new Set([DIGEST_A]));
  });

  it.each([
    ['empty text', ''],
    ['text that is not JSON', 'not json'],
    ['JSON with no DSSE envelope', JSON.stringify({ mediaType: 'x' })],
    [
      'an envelope whose payload is not base64 JSON',
      JSON.stringify({ dsseEnvelope: { payload: '!!!' } }),
    ],
    [
      'a statement with no subjects',
      JSON.stringify({
        dsseEnvelope: { payload: Buffer.from(JSON.stringify({ subject: [] })).toString('base64') },
      }),
    ],
  ])('refuses %s', (_label, text) => {
    expect(() => attestedSha256s(text)).toThrow(PublishError);
  });
});

describe('assertDigestsAttested', () => {
  const attested = new Set([DIGEST_A, DIGEST_B]);

  it('passes when every digest is among the attested subjects', () => {
    expect(() => {
      assertDigestsAttested(
        [
          { label: 'one', sha256: DIGEST_A },
          { label: 'two', sha256: DIGEST_B },
        ],
        attested,
      );
    }).not.toThrow();
  });

  it('names every tarball whose digest was not attested', () => {
    expect(() => {
      assertDigestsAttested(
        [
          { label: 'one', sha256: DIGEST_A },
          { label: 'two', sha256: DIGEST_C },
        ],
        attested,
      );
    }).toThrow(/two/);
  });

  it('passes when there is nothing to publish', () => {
    expect(() => {
      assertDigestsAttested([], attested);
    }).not.toThrow();
  });
});

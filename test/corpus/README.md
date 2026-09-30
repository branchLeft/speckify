# Spec corpus

Real OpenAPI descriptions that `src/e2e/corpus.test.ts` runs through the whole
pipeline, so Speckify is tested against specs its own authors did not write.

- `oai/` holds example descriptions from the OpenAPI Initiative, the authors
  of the standard, vendored unchanged from
  [OAI/learn.openapis.org](https://github.com/OAI/learn.openapis.org).
  Provenance and licences are in [`oai/SOURCES.md`](oai/SOURCES.md).
- `large/` holds one large real-world description, DigitalOcean's public API,
  bundled from [digitalocean/openapi](https://github.com/digitalocean/openapi).
  It tests scale: about 485 operations in one 3 MB document. Provenance, the
  bundling command and its licence are in
  [`large/SOURCES.md`](large/SOURCES.md).

The files are third-party material, kept byte for byte as fetched, so Prettier
ignores this directory.

## What the test does

For every spec, the test checks that Speckify either accepts it or refuses it
with the exact expected lint rule. For example, a Swagger 2.0 file is refused
because only OpenAPI 3.0 and 3.1 are supported. For each accepted spec it
then:

1. plans a first publish;
2. diffs the spec against itself, which must be `none`;
3. applies scripted edits with known bumps (a description edit is patch, a
   new optional query parameter is minor, a new required query parameter is
   major) and checks the plan's bump using the real oasdiff binary;
4. builds the TypeScript and Python packages, client and server, typechecks
   and imports them, and runs the generated-surface diff on each edit.

Step 4 builds real packages for every spec, so it takes about a minute. It runs
in CI, where `CI=true`, or locally with `SPECKIFY_CORPUS_FULL=1`. A plain local
run covers steps 1 to 3.

```sh
SPECKIFY_CORPUS_FULL=1 pnpm vitest run src/e2e/corpus.test.ts
```

## Known failure

The pinned `@hey-api/openapi-ts` generates 474 of the DigitalOcean spec's 485
operations, dropping 11 without an error, although every `operationId` is
unique. Speckify's completeness check catches this and refuses to build. The
test asserts that refusal, so it will fail, and should be updated, once a
generator upgrade stops dropping them.

# speckify

Speckify turns an OpenAPI contract into a versioned, published set of
TypeScript and Python packages — and keeps them honest. It bundles your
spec, works out the semver bump from what actually changed on the wire
(not from what a human remembers to type), generates a client and/or
server package per language, and publishes them once a pull request
merges. A speck, incidentally, is a cured ham: this is roughly how the
speck is made.

## 60-second quick start

In a repo that already has an OpenAPI document:

```sh
npx speckify init --owner your-github-org
```

This detects `openapi*.yaml` / `openapi*.json`, writes a starter
`speckify.yaml` (one contract per spec found), and writes
`.github/workflows/speckify.yml` wired to Speckify's reusable workflow.
Commit both, open a pull request, and Speckify comments the version it
would publish and why. Merge, and it publishes.

`speckify.yaml` looks like this:

```yaml
contracts:
  - name: orders-api
    spec: ./openapi.yaml
    typescript:
      package: '@your-github-org/orders-api'
      client: true
      server: false
    python:
      package: orders-api
      client: true
      server: false

publish:
  githubPackages:
    owner: your-github-org
```

See [`docs/configuration.md`](docs/configuration.md) for the full
reference.

## What's generated

- A TypeScript npm package (client, server, or both — set independently
  per contract), published to **GitHub Packages** under the configured
  owner. GitHub Packages requires a scoped package name matching that
  owner (`@your-github-org/…`); Speckify checks this at config load time
  and again immediately before publishing.
- A Python wheel and sdist (client, server, or both), published to
  **PyPI** via [trusted publishing](https://docs.pypi.org/trusted-publishers/)
  — Speckify never holds or stores a PyPI token; the workflow's own OIDC
  identity is exchanged for a short-lived upload credential at publish
  time.
- Each published package carries the exact bundled spec it was generated
  from (`openapi.json`), which is also how Speckify finds "what did we
  last publish" on a later run — see
  [`docs/versioning.md`](docs/versioning.md).

## How versioning works

Speckify never asks you to pick a version. On every pull request it:

1. Bundles the spec (inlining external `$ref`s into one document) and
   lints it.
2. Reads back the spec bundled into the **last published** version, from
   the registry itself — not git history, not a changelog file. The
   registry is the record.
3. Diffs the two with a pinned build of [`oasdiff`](https://github.com/oasdiff/oasdiff),
   from the perspective of an existing, correctly-written client of the
   API.
4. Classifies every change against a reviewed rule map (major / minor /
   patch / no effect) and takes the highest bump across all of them.
5. **A change oasdiff reports that the map has no entry for is treated as
   `major`.** An unclassified rule is not a soft failure — a worse-case
   guess is the only safe default when nothing has judged the change yet.

The full classification map, and the reasoning behind each judgement
call, is in [`docs/versioning.md`](docs/versioning.md).

## Publishing setup

**GitHub Packages** (TypeScript): the workflow's own `GITHUB_TOKEN` is
enough — no extra secret. `publish.githubPackages.owner` in
`speckify.yaml` must be the org or user the token can publish packages
under, and every `typescript.package` must be scoped to it.

**PyPI** (Python): add this repository as a trusted publisher on the PyPI
project (Settings → Publishing → GitHub), naming this repo, the
`speckify.yml` workflow file, and the `release` environment if one is
configured. No PyPI token is ever stored as a secret.

## Limitations

- **No Go.** TypeScript and Python only, for now.
- **No standalone JSON Schema contracts.** The input is an OpenAPI
  document; a bare JSON Schema with no operations has nothing for
  `oasdiff` to diff a request/response contract against.
- **`patternProperties` is refused at lint time.** Most generators can't
  turn it into a usable type, so a spec that relies on it fails before
  it reaches versioning, rather than generating a package nobody can use.
- **Registries beyond GitHub Packages and PyPI are out of scope.** This
  is a deliberate simplification, not a roadmap gap.

## Development

```sh
nvm use
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licence

MIT, see [LICENSE](./LICENSE).

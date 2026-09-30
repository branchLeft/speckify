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
`.github/workflows/speckify.yml`: a `check` job and a `publish` job, each
calling Speckify's composite action directly, pinned to a single commit.
It also writes `.claude/skills/speckify/SKILL.md`, a coding-agent skill
for working with this contract — pass `--no-agent-skill` to skip it.
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

## How it works

[`docs/design.html`](docs/design.html) explains the technical design with
diagrams: where Speckify sits, the life of a spec, the version gate, the
generated-code comparison, publishing and the supply chain. Open it in a
browser. It was written by Claude Opus 5.5, an AI model made by Anthropic,
and says so at the top.

## How versioning works

Speckify never asks you to pick a version. On every pull request it:

1. Bundles the spec (inlining external `$ref`s into one document) and
   lints it.
2. Reads back the spec bundled into the **last published** version, from
   the registry itself — not git history, not a changelog file. The
   registry is the record.
3. Diffs the two itself, structurally, and judges every change against a
   short allow-list of change shapes known to be safe for an existing,
   correctly-written client: a new operation, a new optional parameter
   or property, a relaxed request constraint, and a few more. A change
   on the list is `minor`, and a documentation-only change is `patch`.
   **Every other change is `major`**, however small it looks.
4. Also diffs them with a pinned build of [`oasdiff`](https://github.com/oasdiff/oasdiff),
   which writes the changelog. oasdiff's own verdict, from a reviewed rule
   map, can raise the bump but never lower it. A rule the map has no entry
   for counts as `major`.
5. Generates both specs with the current toolchain and compares the
   packages' public surfaces, catching a rename or reshuffle a spec-level
   diff can't see — see [`src/surface/surface.md`](src/surface/surface.md).
6. Takes the highest bump of all four inputs — the allow-list, the
   oasdiff classification, a record of what Speckify's own toolchain
   changed (`data/toolchain-impact.json`), and the surface diff.
   Over-bumping is acceptable; under-bumping is not.

The allow-list, and why each entry on it is safe, is in
[`src/version/allow-list.md`](src/version/allow-list.md). The classification map, and the reasoning behind each judgement call,
is in [`docs/versioning.md`](docs/versioning.md).

## Publishing setup

**GitHub Packages** (TypeScript): the workflow's own `GITHUB_TOKEN` is
enough — no extra secret. `publish.githubPackages.owner` in
`speckify.yaml` must be the org or user the token can publish packages
under, and every `typescript.package` must be scoped to it. The action
reads that `owner` itself and passes it to `actions/setup-node` as
`scope`, alongside `registry-url: https://npm.pkg.github.com` — that combination
is what makes `NODE_AUTH_TOKEN` actually authenticate `npm publish`
(setup-node writes the `.npmrc` line that interpolates it; the token
alone, set only as an environment variable, authenticates nothing).
Scoping it to `@<owner>` rather than setting it as the job's default
registry keeps a plain `npm install`/`pnpm install` of a public package
(Speckify's own dependencies, at build time) resolving from the public
registry as normal.

**PyPI** (Python): add this repository as a trusted publisher on the PyPI
project (Settings → Publishing → GitHub), naming **this repo**, its own
`.github/workflows/speckify.yml` (the file `speckify init` wrote here,
whose `publish` job calls Speckify's composite action directly), and the
`release` environment — the `publish` job always runs under it. No PyPI
token is ever stored as a secret.

PyPI's trusted-publishing docs are explicit that a _reusable_ workflow
cannot be the workflow a Trusted Publisher is configured against (the
OIDC token a `workflow_call`-invoked job receives names the reusable
workflow, not the caller). `branchLeft/speckify`'s own
`.github/workflows/speckify.yml` is a reusable workflow, but it is
check-only for exactly this reason — never point a Trusted Publisher at
it, and never add a `publish` job back into it.

## Limitations

- **TypeScript and Python only**, for now.
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

### Third-party material

`data/` ships two files that are oasdiff's own content, not Speckify's,
under the Apache License 2.0 — see [`data/README.md`](data/README.md) for
what each file is and how it's regenerated.

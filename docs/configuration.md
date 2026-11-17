# Configuration

Everything lives in one `speckify.yaml`, found by `--config` (default:
`speckify.yaml` in the current directory).

```yaml
contracts:
  - name: orders-api
    spec: ./openapi.yaml
    typescript:
      package: '@acme/orders-api'
      client: true
      server: false
    python:
      package: orders-api
      client: true
      server: true

publish:
  githubPackages:
    owner: acme
    access: public # optional; restricted if omitted
```

## `contracts[]`

One entry per OpenAPI document this repo owns. A repo with several
independently-versioned APIs declares several contracts; each gets its
own version, its own generated packages, and its own line in the PR
comment.

| Field                           | Required            | Notes                                                                                                                                                                                              |
| ------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                          | yes                 | Kebab-case. Used in the tag (`<name>@v<version>`), the release name, and the PR comment.                                                                                                           |
| `spec`                          | yes                 | Path to the OpenAPI document, relative to `speckify.yaml`.                                                                                                                                         |
| `typescript`                    | no                  | Omit entirely to skip TypeScript generation for this contract.                                                                                                                                     |
| `typescript.package`            | if `typescript` set | An npm package name. Must be scoped to `publish.githubPackages.owner` — see below.                                                                                                                 |
| `typescript.client` / `.server` | no, default `false` | At least one should be `true`, or nothing is generated.                                                                                                                                            |
| `python`                        | no                  | Omit entirely to skip Python generation for this contract.                                                                                                                                         |
| `python.package`                | if `python` set     | Must already be in [PEP 503](https://peps.python.org/pep-0503/) normalised form (lower-case, hyphen-separated) — Speckify does not normalise it for you, so what you write is what gets published. |
| `python.client` / `.server`     | no, default `false` | Same as the TypeScript flags.                                                                                                                                                                      |

## `publish.githubPackages.owner`

The GitHub org or user every contract's TypeScript package publishes
under. GitHub Packages requires an npm package's scope to equal its
publishing owner exactly (case-insensitively) — `@acme/orders-api` can
only ever publish to the `acme` org or user, never anywhere else. Config
loading rejects a `typescript.package` whose scope doesn't match; a
generated package is checked again immediately before the network call
that would publish it, since the generated `package.json` is produced by
a separate step and could in principle disagree with `speckify.yaml` by
the time it's published.

The generated `package.json` also carries the two fields GitHub Packages
needs, so nobody edits it before publishing:

- `repository` — `git+https://github.com/<owner>/<repo>.git`, taken from
  `GITHUB_REPOSITORY` (the repo the run is in). A run with no
  `GITHUB_REPOSITORY`, such as a local `speckify build`, leaves it out; a
  value that is not a plain `owner/repo` fails the build.
- `repository.directory` — where the contract lives in the repository: the
  directory holding its `spec`, relative to the repository root (a
  `spec: ./services/orders/openapi.yaml` gives `services/orders`). It is
  derived, so there is no key for it; it is left out for a spec at the
  repository root or outside it, and whenever `repository` is.
- `publishConfig.registry` — `https://npm.pkg.github.com`, the same
  registry `speckify publish` passes to `npm publish`.
- `publishConfig.access` — `publish.githubPackages.access`: `public` or
  `restricted`, `restricted` if the key is omitted (npm's own default for a
  scoped package, so omitting it changes nothing). GitHub Packages takes a
  package's visibility from its repository and ignores this value; the key
  is there so a package can say what it intends, and so `npm` accepts it.

## Where generated packages are expected to live

`speckify publish` builds each contract itself before publishing it — it
calls the same `buildContract` step `speckify build` does, then reads the
result's own directories rather than reconstructing a path. Both commands
share one `--out` option (default `.speckify/out`), under which each
contract gets its own subdirectory:

- TypeScript: `<out>/<contract-name>/typescript/` — an npm package
  directory with its own `package.json`.
- Python: `<out>/<contract-name>/python/dist/` — the wheel and sdist
  `uv build` produced.

Since `publish` always builds first, the two can never disagree about
layout.

## Packing, attesting and publishing separately

`speckify publish` plans, builds and publishes in one run. Two flags split
it so something can happen to the tarballs in between, such as an
attestation (the composite action does exactly this, by default):

| Flag                   | What it does                                                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--pack-only`          | Plans and builds as usual, then runs `npm pack` on each npm package whose version the registry does not hold, into `--pack-dir`. Writes `speckify-pack.json` there and prints `tarball: <path> sha256:<digest>`. Publishes nothing. |
| `--from-pack`          | Reads `speckify-pack.json` from `--pack-dir` and publishes it without rebuilding or re-planning: each npm package from its tarball, each Python dist from where it was built. Creates the release as `publish` does.                |
| `--pack-dir <dir>`     | Where `--pack-only` writes and `--from-pack` reads, relative to the config directory. Default `.speckify/pack`.                                                                                                                     |
| `--attestation <file>` | With `--from-pack`, repeatable: an attestation bundle file (the `bundle-path` of `actions/attest-build-provenance`). Publishes only if every tarball's digest is a subject of one of them.                                          |

`--from-pack` re-hashes every tarball against the digest `--pack-only`
recorded, and (with `--attestation`) against the attestation's subjects,
before it publishes anything. A tarball that is missing, changed or not
attested stops the run with nothing published.

## Environment variables the CLI reads

| Variable                                 | Used by            | Purpose                                                                                                                               |
| ---------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`                           | `check`, `publish` | Reads the last-published state from GitHub Packages; posts/updates the PR comment; creates the release.                               |
| `NODE_AUTH_TOKEN`                        | `publish`          | The token `npm publish` itself uses. Falls back to `GITHUB_TOKEN` when unset, since the composite action sets both to the same value. |
| `GITHUB_REPOSITORY`                      | `check`, `publish` | `owner/repo`, for the PR comment target, the release target and the generated package's `repository`. Set automatically by Actions.   |
| `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH` | `check`            | Used to detect a `pull_request` run and read the PR number. Set automatically by GitHub Actions.                                      |

Outside of GitHub Actions (a local run), none of these need to be set:
`speckify check` prints to stdout only, and `speckify publish` publishes
without a release.

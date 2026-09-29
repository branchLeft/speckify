# Contributing

## Setup

```sh
nvm use
pnpm install
```

## Workflow

1. Branch from `main`.
2. Write the test first, watch it fail, then implement. This project is
   built test-driven end to end and reviews reflect that.
3. Keep a PR to one concern — a codegen change and a publishing change
   are two PRs, even if they touch adjacent code.
4. Before opening a PR:

   ```sh
   pnpm lint
   pnpm typecheck
   pnpm format
   pnpm test:coverage
   ```

   `pnpm format` checks formatting; it never rewrites — run
   `pnpm format:write` locally to fix.

5. Coverage: 90%+ for any module you touch, and every security-sensitive
   path — token handling, subprocess invocation, anything that decides
   what gets published where — needs unit coverage regardless of the
   overall number. An end-to-end happy path is not a substitute for a
   unit test of the failure case.

## Commit and PR conventions

- Commit messages: imperative mood, one logical change per commit.
- PR description: what changed and why, not a restatement of the diff.
- No secrets, no tenant- or customer-identifying data, no internal
  tooling references in source, comments, or commit messages — this repo
  is public.

## Project layout

| Path                                                                                | Owns                                                             |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `src/bundle`, `src/lint`, `src/oasdiff`, `src/version`, `src/record`, `src/plan.ts` | Bundling, linting, diffing, classification, the registry record  |
| `src/codegen/typescript`, `src/codegen/python`                                      | Client/server package generation                                 |
| `src/publish`, `src/github`, `src/comment`                                          | Publishing to GitHub Packages / PyPI, releases, the PR comment   |
| `src/init`                                                                          | `speckify init`                                                  |
| `action.yml`, `.github/workflows`                                                   | The composite action and reusable workflow a producer repo calls |
| `launcher/`                                                                         | The PyPI launcher package (`pip install speckify`)               |
| `examples/`                                                                         | A small contract used by the docs and an end-to-end test         |

## Running the example end to end

```sh
pnpm test -- src/e2e
```

This bundles and plans `examples/pet-shelter` against a mocked "never
published" registry state. It hands the bundled spec to
`src/codegen/typescript` and `src/codegen/python` if they're present on
your branch, and skips each with a logged reason if not — codegen and
publishing are built on separate branches from this seam.

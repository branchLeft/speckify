# Computing a contract's plan

`computeContractPlan` produces one contract's changelog, bump and version
from its freshly bundled spec.

## Lint runs first

The bundled spec is linted before anything else. A lint failure — an
unsupported `openapi` version, a missing or duplicate `operationId`, a
`patternProperties` schema — throws `LintError` and never reaches oasdiff,
so a spec codegen can't handle never gets a version stamped into it at all.

## First publish has nothing to diff against

A contract with no `previous` entry (never published, on either registry)
diffs against nothing: `changes` is empty and the bump always resolves to
the first published version, regardless of what the toolchain-impact bump
would otherwise say. There is nothing to compare its spec to yet.

## `info.version` is normalised before any comparison

The freshly bundled spec always carries the `0.0.0` placeholder; a
previously published spec's stored copy always carries its real, stamped
version. Both are normalised to the same placeholder before oasdiff ever
sees them, and before the raw-text-equality check below — otherwise a
version-number difference (or oasdiff's own `api-version-not-bumped`
check) would show up as a "change" on every single plan, published or not.

## oasdiff reporting nothing is not proof that nothing changed

When oasdiff reports zero changes but the spec text still differs once
`info.version` is normalised, that text difference is only trusted as
patch-level when it is _entirely_ doc-only: `description`, `summary`,
`example`/`examples`, `externalDocs` and `title`, stripped from both sides
recursively. Anything else that differs — a schema constraint, a `servers`
URL, a security requirement — means oasdiff missed something real, and
under-bumping that is worse than over-bumping, so it bumps MAJOR instead.

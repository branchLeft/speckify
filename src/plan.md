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

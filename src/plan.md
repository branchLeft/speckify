# Computing a contract's plan

`computeContractPlan` produces one contract's changelog, bump and version
from its freshly bundled spec.

## Lint runs first

The bundled spec is linted before anything else. A lint failure — an
unsupported `openapi` version, a missing or duplicate `operationId`
(including two ids equal once case and separators are ignored), two
parameters of one operation with names equal in the same way, a
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

## The bump is the allow-list's verdict, raised by oasdiff's

The plan diffs the two specs structurally and judges every edit against the
allow-list in [`version/allow-list.md`](version/allow-list.md): patch for a
documentation-only difference, minor for a listed safe change shape, major
for anything else. Each judgement is returned on the plan as `judgements`.

oasdiff still runs on every plan and its changes become the changelog. Its
classification joins the allow-list's verdict in a max, so it can raise the
bump but never lower it. oasdiff failing aborts the plan.

When no edit is above patch but the text still differs, the difference must
be annotations or inert vendor extensions alone. Anything else means the
structural diff missed something, and the bump is major. Identical specs,
once `info.version` is normalised, publish nothing.

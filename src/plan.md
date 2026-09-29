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

## NAME_MAP_KEYS and structural change detection

`NAME_MAP_KEYS` identifies containers whose children are arbitrary, producer-chosen names: property names, schema names, path templates, status codes, media types, security scheme names, discriminator mapping keys. These are never fixed JSON-Schema/OpenAPI keywords.

When comparing specs, both `stripDocOnlyKeys` and `collectChangedKeywords` must handle these containers specially:

- `stripDocOnlyKeys` must not treat a child key as a doc-only annotation just because it happens to spell "title" or "description" (a property can be legitimately named either)
- `collectChangedKeywords` must not treat a child key as "the keyword that changed" — adding or removing a property, schema, or path is not a keyword-level edit at all, and is exactly what oasdiff's ordinary rules already cover

## Structural fallback: collectChangedKeywords

`collectChangedKeywords` walks two doc-stripped, version-normalised spec trees and collects every JSON-Schema/OpenAPI _keyword_ whose value differs — `additionalProperties`, `servers`, `minLength`, `type`, etc.

### Algorithm details

Only genuine changes to a _shared_ child's value recurse further (so a property present in both versions can still surface keyword changes inside its own schema). A child on only one side is a plain addition/removal and is not descended.

Array-valued keywords (`servers`, `required`, `enum`, operation `parameters`, etc.) are compared as one atomic unit: any element-level difference reports the keyword itself, not a position inside the array.

### Relationship to oasdiff coverage

This feeds speckify's fallback when oasdiff has no rule for a detected keyword. Covered keywords (from `src/version/covered-keywords.ts`) enumerate what oasdiff _does_ rule on; a keyword difference oasdiff cannot classify forces a major bump to avoid silently missing a breaking change.

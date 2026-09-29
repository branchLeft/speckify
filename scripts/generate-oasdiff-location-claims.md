# oasdiff location claims script

## Purpose

Derives every rule location oasdiff's own catalogue declares from
`data/oasdiff-<version>.checks.json`. That file is the verbatim output of
oasdiff's `checks changelog --format json`, which
`version/classification-map-completeness.test.ts` already cross-checks
against the live binary. The result is written to
`data/oasdiff-<version>.location-claims.json`.

## Shape

Each rule declares its `locations` as oasdiff claims,
`pattern:action[,action...]`. See the oasdiff source at the pinned tag:
`checker/metaschema/claim.go` and `checker/metaschema/location.go`. An
example is `paths.*.*.requestBody.content.*.schema.maxLength:decrease,increase`.

The script keeps the pattern verbatim. It merges every rule that declares
the same pattern into one entry holding the union of their actions. Patterns
and actions are sorted, so the file is deterministic. A malformed claim, one
with no pattern or no action, fails the script rather than being skipped.

## Relationship to plan.ts

`src/version/location-coverage.ts` loads this file and matches each
structural edit against it using oasdiff's own `*` / `**` semantics. The
full design is in `src/version/location-coverage.md`. The
`location-claims-completeness` test re-derives the file from the committed
catalogue and fails on any drift, so an oasdiff upgrade must regenerate it:

```sh
node scripts/generate-oasdiff-location-claims.mjs <oasdiffVersion>
```

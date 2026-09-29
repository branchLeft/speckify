# oasdiff covered keywords script

## Purpose

Derives the set of JSON-Schema/OpenAPI _keywords_ oasdiff's own rule catalogue ever looks at, from the same committed rule catalogue (`data/oasdiff-<version>.checks.json`, itself the verbatim output of oasdiff's `checks changelog --format json`) that `version/classification-map-completeness.test.ts` already cross-checks against the live binary.

## How oasdiff rules map to keywords

Each rule declares its `locations` as oasdiff's own "pattern:action[,action...]" claims (see the oasdiff source, `checker/rules.go` and `checker/metaschema/claim.go`, at the pinned tag) — e.g. `paths.*.*.requestBody.content.*.schema.deprecated:set`.

The keyword a rule actually judges is the pattern's last concrete (non-"\*", non-"\*\*") path segment: "deprecated" there.

A pattern that _ends_ in a wildcard, e.g. `paths.*.*.requestBody.content.*.schema.properties.*`, names a whole family of arbitrarily-named children (property names, schema names, path templates, ...) rather than a keyword itself; the keyword there is the nearest concrete segment before the wildcard ("properties").

## Relationship to plan.ts

`plan.ts`'s structural fallback uses this set the other way round: a real structural difference at a keyword _not_ in this set is one oasdiff has no rule for at all, and can never under-bump on its own account — Speckify forces major rather than trust silence there.

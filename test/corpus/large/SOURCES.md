# Provenance: one large real-world spec

The maintainer's request specifically asked for "more substantial spec
files" beyond hand-sized fixtures. One large, permissively licensed,
real-world API description is vendored for scale: `digitalocean-v2.bundled.yaml`,
DigitalOcean's public API v2.

## Why this one

Candidates considered: GitHub's REST API description
(`github/rest-api-description`) and Stripe's OpenAPI description were both
ruled out as multi-megabyte, multi-thousand-operation documents that would
meaningfully bloat this public repository and its clone size for a corpus
that only needs one spec at this scale; DigitalOcean's is real, actively
maintained, permissively licensed, and its bundled form is a manageable
single file.

## Source

- Repository: `github.com/digitalocean/openapi`
- Commit: `b431341a76ffacebeed48067ed4db1836e9c062c` (fetched 2026-09-30,
  `main`, committed 2026-09-29)
- Source file: `specification/DigitalOcean-public.v2.yaml`, which itself
  `$ref`s ~3,000 files across `specification/resources/` and
  `specification/shared/` (485 operations, ~13MB of source across the whole
  tree) — too many small files to vendor as-is without either committing the
  entire multi-file tree or the tree's git history noise.

## What's vendored, and how

`digitalocean-v2.bundled.yaml` (3.1MB) is a **bundled** (all `$ref`s
resolved into one self-contained file), not a byte-for-byte copy: produced
with `@redocly/cli@1.34.20`'s `bundle` command run locally against the
pinned commit above —

```
npx @redocly/cli@1 bundle specification/DigitalOcean-public.v2.yaml -o digitalocean-v2.bundled.yaml --ext yaml
```

Redocly's bundler reported two schema-name collisions it resolved by
renaming (`parameters_region` → `parameters_region-2`,
`urn` → `urn-2`); both are visible in the output file and are Redocly's own
deterministic renaming for a name reused with different content at two
`$ref` sites, not a hand edit.

## Licence

- `LICENSE` at the repository root (vendored here as
  `LICENSE-digitalocean-openapi.Apache-2.0.txt`): **Apache License 2.0**.
- `package.json`'s `"license"` field agrees: `Apache-2.0`.
- No `NOTICE` file exists in the source repository.

Attribution: DigitalOcean, LLC and contributors to
`digitalocean/openapi`.

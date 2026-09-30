# Provenance: OAI-authored example descriptions

Vendored unchanged (byte-for-byte, YAML form only) from the OpenAPI
Initiative's own repositories, for battle-hardening the pipeline against
real specs written by the authors of the standard rather than fixtures we
wrote ourselves.

## Source repository

`github.com/OAI/learn.openapis.org`

- Commit: `bbb743ed3b7c5ed76b6e6ba9b302af38f3956c44` (fetched 2026-09-30,
  `main`, committed 2026-09-22)
- Fetched with `git clone --depth 1`

`github.com/OAI/OpenAPI-Specification` was also checked (per the maintainer's
request, "its `examples/` if present at a current tag"): at its current tag
(`447c479c9c7136918e80a57a258fd6c84f369c7c`) it has **no `examples/` directory
at all** — the OAI repo migration moved every example to
`learn.openapis.org`, which is the only source used here.

## Files

| Vendored path                        | Source path (learn.openapis.org)         | OAS version |
| ------------------------------------- | ----------------------------------------- | ----------- |
| `v3.0/petstore.yaml`                  | `examples/v3.0/petstore.yaml`             | 3.0.0       |
| `v3.0/petstore-expanded.yaml`         | `examples/v3.0/petstore-expanded.yaml`    | 3.0.0       |
| `v3.0/api-with-examples.yaml`         | `examples/v3.0/api-with-examples.yaml`    | 3.0.0       |
| `v3.0/callback-example.yaml`          | `examples/v3.0/callback-example.yaml`     | 3.0.0       |
| `v3.0/link-example.yaml`              | `examples/v3.0/link-example.yaml`         | 3.0.0       |
| `v3.0/uspto.yaml`                     | `examples/v3.0/uspto.yaml`                | 3.0.1       |
| `v3.1/non-oauth-scopes.yaml`          | `examples/v3.1/non-oauth-scopes.yaml`     | 3.1.0       |
| `v3.1/tictactoe.yaml`                 | `examples/v3.1/tictactoe.yaml`            | 3.1.0       |
| `v3.1/webhook-example.yaml`           | `examples/v3.1/webhook-example.yaml`      | 3.1.0       |
| `v2.0/petstore.yaml`                  | `examples/v2.0/yaml/petstore.yaml`        | Swagger 2.0 |

The Swagger 2.0 petstore is included deliberately: it is the
`openapi-version` lint rule's other refusal case (alongside
`patternProperties`, already covered by an existing fixture), on a spec the
standard's own authors published, not one we wrote to trip the rule.

## Licence

This is genuinely ambiguous in the source repository and is recorded here
rather than resolved by guessing:

- The repository's root `LICENSE` file (vendored here as
  `LICENSE-learn.openapis.org.CC-BY-4.0.txt`) is **Creative Commons
  Attribution 4.0 International** — the licence OAI uses for the learn site's
  written content.
- `package.json` at the repository root declares `"license": "Apache-2.0"`,
  which is the licence OAI's code-bearing repositories (including
  `OpenAPI-Specification` itself) use.

The example files are data/code (OpenAPI documents), not prose, so
`Apache-2.0` is the better fit and the one Speckify treats them under; the
CC-BY text is kept alongside for transparency about the ambiguity and in
case attribution is what actually applies. No `NOTICE` file exists in the
source repository. Attribution: the OpenAPI Initiative (OAI) and
contributors to `OAI/learn.openapis.org`.

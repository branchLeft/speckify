# Generating the Python client

`generateClient` runs openapi-python-client against the bundled spec and
writes the result at `<targetDir>/client/`, importable as
`<import_name>.client`.

Two of openapi-python-client's own config options place the output there
directly, with no extra nesting or generated `pyproject.toml`/README that
Speckify's own package layout already owns:

- `package_name_override: client`
- `--meta none`

Both are the tool's documented options, never a regex patch of its output.

## Completeness guard

openapi-python-client 0.29.1 silently skips endpoints it cannot handle
instead of erroring on them. `generateClient` checks every `operationId` in
the spec against the functions actually generated and throws
`CompletenessGuardError` (see `completeness-guard.ts`) if any are missing —
a spec speckify can't fully generate a client for must fail loudly, not
ship a client with holes in it.

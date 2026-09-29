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

## Keyword-only generated models

`generateClient` also passes `--custom-template-path` (another documented
option) at `./templates/openapi-python-client/`, which carries one file:
`model.py.jinja`, a copy of the pinned 0.29.1 package's own template with a
single change — `@_attrs_define` becomes `@_attrs_define(kw_only=True)`.

Without it, a generated model's constructor takes its fields
positionally, in the order they appear in the spec. Inserting a new
optional property anywhere but last then shifts every later field's
position — a change the surface diff (rightly) reads as breaking a
positional caller, even though nothing about the change was actually
unsafe. Keyword-only removes field order from the public surface
entirely, the same way datamodel-code-generator's pydantic models already
are (see `../../surface/surface.md` §4 and `../../surface/python.ts`).
Construct a generated model positionally and it now raises `TypeError`,
proving the constructor really is keyword-only.

Only `model.py.jinja` is overridden — every other template renders exactly
as the pinned package ships it.

## Completeness guard

openapi-python-client 0.29.1 silently skips endpoints it cannot handle
instead of erroring on them. `generateClient` checks every `operationId` in
the spec against the functions actually generated and throws
`CompletenessGuardError` (see `completeness-guard.ts`) if any are missing —
a spec speckify can't fully generate a client for must fail loudly, not
ship a client with holes in it.

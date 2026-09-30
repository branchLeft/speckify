# Server boilerplate

Setting `client: true` on a contract generates a typed client for calling
the API. Setting `server: true` generates the _other_ side: request and
response types, and the routing/validation scaffolding a real
implementation plugs handlers into — never a working service on its own.

## What a server package gives you

- Request and response types for every operation, generated from the
  same bundled spec the client uses — so client and server can never
  silently disagree about a shape, because they're generated from the
  same document in the same run.
- Parameter and request-body validation wired to the spec's own schemas,
  so a malformed request is rejected before it reaches your handler code.
- A typed handler interface: one function signature per operation, with
  the request already parsed and validated, and the return type
  constrained to the response shapes the spec declares for that
  operation.

## Exactly what the Python server validates

The Python router checks the following before your handler runs. A failed
check is rejected with 422.

- **Path, query and header parameters**, including those declared on the
  path item or through a `$ref`:
  - Coerced to `int`, `float` or `bool` as the schema's `type` says.
    `nan` and `inf` are not numbers.
  - A `required` parameter must be present.
  - `enum` is checked for string, number and boolean members.
  - `minimum`, `maximum`, both exclusive bounds, `minLength`, `maxLength`
    and `pattern` are checked. Exclusive bounds work in both the OpenAPI 3.0
    boolean form and the 3.1 numeric form.
  - An array query parameter checks each repeated value against its
    `items` schema. A required one needs at least one value.
- **An `application/json` request body** is validated by a generated
  pydantic model. This holds whether the schema is a `$ref` or written
  inline: an inline schema is given a model named
  `<OperationId>RequestBody` when the package is generated.
  - A required body that is empty or `null` is rejected with 422.
  - An optional body that is absent reaches the handler as `None`.
  - Malformed JSON is rejected with 400.
  - A body over 1 MiB is rejected with 413 before it is fully read. The
    limit is configurable through `create_router`.

These are **not** validated. The value reaches your handler as described:

- Array-level keywords on a query parameter: `minItems`, `maxItems` and
  `uniqueItems`.
- An object-typed parameter (for example `style: deepObject`), and an array
  path or header parameter. Each arrives as the raw string.
- A parameter's `format` (`date-time`, `uuid`, ...). The value arrives as a
  string.
- Cookie parameters, which are not read.
- A JSON body whose media type declares no schema. It arrives exactly as
  parsed.
- A body under any media type other than `application/json` or
  `application/octet-stream` (for example `application/merge-patch+json`).
  It is not passed to the handler.
- Responses. The handler's return type constrains them, but the router
  does not check them against the spec at run time.

## What it does not give you

- Authentication, authorisation, or any business logic — that's what you
  write.
- A database, a queue, or any other backing service.
- A deployed anything. The generated package is a library your service
  depends on, not a service in itself.

## Why generate this at all

Without it, "the server matches the spec" is an assertion a human has to
keep re-verifying by hand, forever, as the spec evolves. With it, a
handler that doesn't satisfy the generated interface fails to compile —
the same versioning pipeline that stops an incompatible client from
silently breaking (see [`versioning.md`](versioning.md)) also stops an
incompatible server implementation from shipping.

## Combining client and server

A contract can set both `client: true` and `server: true` — common for a
service that also ships an SDK for calling itself, or for a monorepo
where one package tests its own server against its own generated client.
Both are generated from the same bundled spec in the same run, so they
never disagree with each other even transiently.

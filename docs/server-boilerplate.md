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

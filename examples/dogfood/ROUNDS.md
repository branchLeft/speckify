# Dogfood: notes API, four rounds, in earnest

`examples/dogfood/` is Speckify's first in-earnest dogfood: a tiny notes API
(`list`/`get`/`create`, a `Note` with `id`, `title`, `body`), driven through
Speckify's own library API (`computeContractPlan`, `buildContract`, the real
`oasdiff` binary, the real generated-surface diff) across four rounds --
a first publish, a patch, a minor and a major -- with two real, running
apps per round:

- **Pair 1**: a generated **TypeScript client** (`apps/ts-client/`) calling
  a real **Python FastAPI server** (`apps/py-server/`) that implements the
  generated `Handlers` Protocol via `create_router`.
- **Pair 2**: a generated **Python client** (`apps/py-client/`) calling a
  real **TypeScript `node:http` server** (`apps/ts-server/`) that
  implements the generated `Handlers` interface via `createRequestListener`
  (`createServer`).

Both pairs run for real over HTTP on an ephemeral port, for every round.
The harness is `src/e2e/dogfood.test.ts`, gated like `corpus.test.ts`
(`CI=true` or `SPECKIFY_CORPUS_FULL=1`); a plain local run skips it.

## Per-round results

| Round | Change                                          | Expected bump | Computed           | App code required                                                   |
| ----- | ----------------------------------------------- | ------------- | ------------------ | ------------------------------------------------------------------- |
| R0    | first publish                                   | --            | `none` -> `1.0.0`  | Full implementation, both pairs                                     |
| R1    | description-only edit                           | patch         | `patch` -> `1.0.1` | **None**                                                            |
| R2    | add optional `tags` on `Note`; add `deleteNote` | minor         | `minor` -> `1.1.0` | Implement `deleteNote` in both servers; read `tags` in both clients |
| R3    | remove `body` from `Note`'s response            | major         | `major` -> `2.0.0` | Stop reading `.body` on a fetched `Note` in all four apps           |

All four bumps and versions were asserted against the real `oasdiff`
classifier and the real TypeScript+Python generated-surface diff
(`compareGeneratedSurfaces`), not a mock.

**R1 needed zero code changes.** A description-only spec edit regenerated
byte-identical handler/route/model shapes; the R0 app files were reused
unmodified for R1's run. This is exactly what a patch bump should mean, and
it's reassuring to see it hold in a real regenerate-and-rerun, not just in
the version-bump unit tests.

**R2's additions were genuinely additive.** `tags` being optional meant the
existing `Note` construction code in both servers kept compiling with no
change; only the new `deleteNote` operation required a new handler method
(TS: one more property on the `Handlers` object literal; Python: one more
`async def` on the class). Both languages caught a missing handler for the
new operation at generation time via Speckify's own completeness guard, not
at runtime.

**R3 forced a real breaking-change fix, and the two languages caught it
differently.** Removing `body` from `Note`'s response:

- In **TypeScript**, `note.body` and `fetched.data.body` stopped
  typechecking immediately -- `tsc --strict` refused to compile until the
  reads were removed. The break is caught before the app ever runs.
- In **Python**, there is no static type checker in this harness (see
  "Python typechecking" below), so `note.body` would only fail at _request
  time_, as an `AttributeError` on the generated `attrs` model. The
  breaking change is real in both languages; only one of them tells you at
  build time.

This is the clearest evidence this exercise produced for _why_ a major
bump matters: the same spec edit is a compile error in one consumer and a
runtime crash in the other, and neither consumer would have noticed from
reading a changelog alone -- the type system (where there is one) is what
actually stops you from shipping it.

## Bugs found and fixed (test-first, each its own commit)

1. **The generated TypeScript package's own README doesn't work.**
   `package-files.ts` ships a README telling every consumer to
   `import { client } from '<package>'` and call
   `client.setConfig({ baseUrl })` -- the only documented way to point the
   generated SDK at a real server. But `@hey-api/openapi-ts`'s own
   `index.ts` output never re-exports that binding, only the bound SDK
   functions and types, so the documented usage silently didn't exist.
   Fixed in `src/codegen/typescript/generate.ts` by appending
   `export { client } from './client.gen.js';` to the generated `index.ts`
   when a client is requested. Without this fix, pair 1's TypeScript client
   in this exercise would have had **no supported way to reach the Python
   server at all.**

2. **A generated Python server 500s on any array-of-objects response.**
   An array response (`type: array, items: {$ref: ...}`) has no top-level
   `$ref` for `operations.py`'s `toResponseInfos` to bind a model name to
   -- the ref lives one level down, inside `items` -- so the response body
   is typed as a bare `dict[str, typing.Any]`. The generated router's
   `_json_response` only special-cased a single `pydantic.BaseModel`, not a
   list of them, so a handler returning the list of real model instances it
   already has (the natural thing to do, not a contrived edge case)
   crashed with `TypeError: Object of type Note is not JSON serializable`
   -- starlette's default JSON encoder cannot serialise a pydantic model.
   Fixed in `src/codegen/python/templates/router.py.jinja`. Without this
   fix, `listNotes` -- the very first endpoint this dogfood's Python server
   implements -- would 500 on every call.

Both were found by building and running the real generated packages, not
by reading the generator's source: bug 1 only shows up once you actually
try to import from the package root the way the README says; bug 2 only
shows up once a handler returns real model instances in a list rather than
a hand-built dict, which every existing test for that template did.

## Other surprises

- **`RequestResult`'s `data`/`error` fields don't narrow together.**
  `@hey-api/client-fetch`'s generated `RequestResult` type intersects the
  `{data, error}` union with `{request?; response?}`. TypeScript does not
  distribute a discriminant check through that intersection, so
  `if (result.error !== undefined) throw ...` narrows `error` but leaves
  `result.data` typed `T | undefined` regardless. The fix in every
  `apps/ts-client/*.ts` file is to guard on `result.data === undefined`
  directly wherever `.data` is read afterwards, not on `.error`. This is
  inherent to `@hey-api/client-fetch`'s own type (Speckify doesn't author
  it), but it's a real first-use trap for anyone following the obvious
  pattern.
- **The generated array response type is a lie, benignly.** As bug 2 above
  shows, `ListNotesResponse200.body: dict[str, typing.Any]` in the
  generated Python `Handlers` Protocol doesn't describe what a handler
  actually returns (`list[models.Note]`); this is a known, narrower gap
  than bug 2 (the response is still served correctly now) but a future
  improvement would be threading the array's item type through so
  `py_body_type` reads `list[models.Note]` and a handler gets real
  static checking on its return value.
- **Python typechecking in this harness is "import and run", not
  `pyright`.** The task allows either; this dogfood used real execution
  (the FastAPI/httpx round trip) because it already proves the generated
  types work correctly end to end, and setting up `pyright` against an
  ephemeral `uv`-installed wheel per round would have added real
  complexity for a check real execution already subsumes. The R3 finding
  above (`AttributeError` at runtime, not a static error) is itself the
  direct consequence of that choice, not an artifact of skipping pyright:
  Python's own type system doesn't check attribute access at the language
  level the way TypeScript's `strict` does.

## Timings

The full four-round run (bundling, planning against the real `oasdiff`
binary, the real generated-surface diff for R1-R3, building both languages,
strict-typechecking and compiling two TypeScript consumer apps per round,
and running two real client/server round-trips per round) takes
**~23 seconds** on the machine this was developed on. Per round: R0 ~5s,
R1 ~6s, R2 ~6s, R3 ~6s (R1-R3 are slightly slower than R0 because they also
run the generated-surface diff against the previous round's build).

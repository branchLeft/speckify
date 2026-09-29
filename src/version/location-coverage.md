# Location coverage: when oasdiff's verdict can be trusted

Speckify's version bump must never under-count a breaking change. oasdiff
computes the changelog and its classification drives the bump, but oasdiff
only judges some changes at some places in a document. A change it does not
judge is invisible to it, and its silence about that change says nothing.
When oasdiff reports _something else_ in the same diff, trusting its bump
would let the unjudged change inherit an unrelated, smaller bump. So every
structural change Speckify finds must be shown to sit where oasdiff judges
it; any change that cannot be shown that way is **uncovered**, and an
uncovered change forces MAJOR. Over-bumping is acceptable; under-bumping is
not.

An earlier version matched coverage by keyword name alone (`maxLength` is
judged _somewhere_, so a `maxLength` change _anywhere_ was trusted). oasdiff
judges each keyword only at particular locations: a query parameter's
`items`, a `deepObject` parameter's properties and anything under
`callbacks` are never judged. This design replaces keyword coverage with
location coverage.

## 1. The structural diff runs on dereferenced documents

Both documents are prepared the same way before diffing:

1. `info.version` is normalised to the `0.0.0` placeholder.
2. Documentation-only keys are stripped in annotation position (never as a
   member name of a name map — a property called `title` is data):
   `description`, `summary`, `example`, `examples`, `externalDocs`, `title`.
   At the document root, `tags` and `info.contact`, `info.license` and
   `info.termsOfService` are stripped as well: oasdiff's own object model
   marks them as annotations, and the SDK-visible part of tagging is the
   operation's `tags` list, which is diffed.
3. Every local `$ref` outside `components` is inlined in place, so each
   change surfaces at its full concrete location, for example
   `paths./things.get.parameters.query:tags.schema.items.maxLength`.
   Operation parameters are addressed by `in:name`, as oasdiff identifies
   them.
4. Cycles are detected with the stack of references being expanded. A
   reference already on the stack is left as `{ $ref }`, and every component
   on that cycle is marked **cyclic**. A `$ref` that cannot be resolved is
   left in place, so any change to it is a change at a `$ref` location, which
   no rule covers.
5. Sibling keys next to a `$ref` are kept under a `$refSiblings` key, which
   no rule covers. Whether oasdiff honours such siblings is not something
   Speckify can verify.

## 2. Edits: a location plus an action

The diff emits **edits** in oasdiff's own vocabulary (`checker/metaschema`
at the pinned tag): a location (a list of segments) and one syntactic
action.

| Value at the location                                    | Actions                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| member of a name map or keyed list (property, path, ...) | `add`, `remove`                                                     |
| list of scalars (`enum`, `required`, `type`, op `tags`)  | `add` / `remove` per member                                         |
| number                                                   | `set`, `unset`, `increase`, `decrease`                              |
| boolean                                                  | `set` (became true), `unset` (was true), `change` (absent ↔ false) |
| string or any other value (`default`, `const`, ...)      | `set`, `unset`, `change`                                            |
| object appearing or disappearing                         | `set`, `unset`                                                      |

A vendor extension segment such as `x-internal` is written `x-*`, which is
how oasdiff spells every extension location. `type` is normalised to a set,
so `string` → `integer` is a `remove` plus an `add`.

A boolean going from absent to `false`, or back, is not oasdiff's `set` or
`unset`. Where the default is `true` (for example `explode` on a form
parameter), that transition changes behaviour. So it is a `change`, which no
boolean claim lists, and it is MAJOR. `additionalProperties`, `default`,
`const` and `$ref` are compared as opaque values: absent → `false` is a
`set`.

## 3. Components are judged where they are used

After inlining, a referenced component's content appears at each use site
and is judged there. So under `components.{schemas, parameters, responses,
requestBodies, headers, callbacks, pathItems, links, examples}`:

- A content change to a component referenced from outside `components` on
  **both** sides, and not cyclic, emits nothing itself: its use sites carry
  it.
- Any other content change (an unreferenced component, which still shapes
  generated SDK types, or a cyclic one that inlining cannot expand fully)
  emits one edit at `components.<kind>.<name>` with action `change`. No rule
  covers that, so it is MAJOR.
- Adding or removing a component that is referenced on the side where it
  exists emits nothing: the use sites changed too. Adding or removing an
  unreferenced one is an ordinary `add`/`remove` edit and needs a rule
  location. `components.schemas.*:remove` has one; a removed component
  header, callback or response does not, so it is MAJOR.

`components.securitySchemes` is not referenced by `$ref` and is diffed
literally, like every other part of the document.

## 4. Coverage is a location-pattern match

`data/oasdiff-<version>.location-claims.json` holds every rule location
oasdiff's catalogue declares (`checks.json`'s `locations`), merged by pattern
with the union of their actions. `scripts/generate-oasdiff-location-claims.mjs`
generates it; a completeness test re-derives it and compares.

Matching is oasdiff's own `MatchLocation`: patterns split on `.`; `*` matches
exactly one segment; `**` matches any run of segments, including none;
anything else matches literally. Speckify matches segment lists, never dotted
strings, because a path template such as `/v1.2/things` contains dots. An
edit is matched by a claim when the location matches and the claim lists
the edit's action.

### Where nested schemas collapse onto a claim

oasdiff's metaschema declares a body schema keyword once, for example
`paths.*.*.requestBody.content.*.schema.maxLength`, and documents that this
"stands for that keyword at any nesting depth inside the request body
schema". Its checker honours that only for request and response **body**
schemas, whose walk descends into sub-schemas. For parameters and response
headers it judges the top-level schema only (the reviewer's
`items.maxLength` and `deepObject` cases).

So only under `…requestBody.content.<mt>.schema` and
`…responses.<status>.content.<mt>.schema` does Speckify collapse
intermediate descents before matching:

- `properties.<name>`, `items`, `additionalProperties`, `anyOf.<i>`, and
  `allOf.<i>` (oasdiff runs with `--flatten-allof`).
- `oneOf` and `not` are **never** collapsed. Under `not`, oasdiff reports
  with the direction of the inner schema, which is inverted: relaxing a
  `not` narrows what is accepted. Under `oneOf`, relaxing one branch can
  make a value match two branches, which then fails. Anything inside them
  stays literal, so it matches no claim. `prefixItems`, `contains`,
  `if`/`then`/`else` and the other sub-schema keywords are not collapsed
  either: no empirical evidence supports them yet.
- A descent is only collapsed when something follows it, so a property's
  own `add`/`remove` still reads `…schema.properties.*`.

Parameters, headers, path-level parameters, callbacks and webhooks are
matched literally. Nothing under `callbacks` matches any claim, so all
callback changes, including a callback's removal, are MAJOR.

### Claims oasdiff declares but does not honour

The empirical validation (section 7) found claims that the pinned oasdiff
declares but on which it reports nothing, for some schema positions (the
_class_ of the collapsed location). Examples: `pattern` on a body schema's
root, generic `x-*` edits, `readOnly` on an `items` schema. These are kept,
with the reason, in `data/oasdiff-<version>.silent-claims.json`. That file
is hand-curated, never generated from oasdiff output. An edit whose claim is
listed there for its class is uncovered. A completeness test checks that
every entry names a real claim pattern and a subset of its actions.

For oasdiff 1.32.1 the list covers:

- On body schemas: `enum` values added at the root; `pattern` at the root;
  generic `x-*`; `readOnly` and `writeOnly` except on a named property;
  `deprecated` except on a named property outside `allOf`; and `nullable`,
  `discriminator`, `prefixItems` and `if`/`then`/`else` inside an `allOf`
  branch.
- On parameters: a generic `x-*` on the parameter or its schema; a property
  added to an object parameter schema, or made required.
- On the operation: a generic `x-*`.
- On security schemes: OAuth flow `scopes`, `tokenUrl` and
  `authorizationUrl`, whether or not the scheme is in use.

So a vendor extension edit now matches its `x-*` claim, but oasdiff 1.32.1
judges only the specific extensions it knows, such as `x-extensible-enum`
and `x-stability-level`. A generic extension edit therefore stays MAJOR.

A collapsed body-schema location has one of these classes, set by the last
descent that was not `allOf`:

| Class       | Meaning                                                             |
| ----------- | ------------------------------------------------------------------- |
| `root`      | the body schema itself                                              |
| `property`  | a schema reached through `properties.<name>`                        |
| `subschema` | a schema reached through `items`, `additionalProperties` or `anyOf` |

Each class gets a `+allOf` suffix when one or more `allOf` descents follow
that last descent. Everything outside body schemas has class `root`.

## 5. Mislabels: a new request constraint is always MAJOR

oasdiff can report a change under a rule whose direction contradicts it.
The reviewer's case: a query array's `items` gains `enum: [a, b]`, where
there was no enum. That narrows what a client may send, but oasdiff reports
`request-parameter-property-enum-value-added`, a widening. So any edit that
**introduces** a constraint where none existed, anywhere inside a request
schema (parameters, path-level parameters, request body), is uncovered
whatever oasdiff says. Adding a constraint where there was none can only
narrow what a client may send.

The keywords treated this way are `enum`, `const`, `maxLength`,
`minLength`, `maximum`, `minimum`, `exclusiveMaximum`, `exclusiveMinimum`,
`multipleOf`, `pattern`, `format`, `maxItems`, `minItems`, `uniqueItems`,
`maxProperties`, `minProperties`, `maxContains`, `minContains`, `required`
(from absent or empty) and `additionalProperties` (becoming `false`).

## 6. Runtime corroboration, and the unconditional check

The coverage check runs on every plan, not only when oasdiff reports
nothing. The bump is MAJOR when any edit is uncovered. That holds when:

- no claim matches it, or
- its claim is listed as silent for its class, or
- it is a new request constraint (section 5), or
- it sits under an operation (`paths.<p>.<method>…`) or a path item
  (`paths.<p>.parameters…`) for which oasdiff reported no change at all.

That last condition is a cheap, per-run cross-check of the claim tables. A
covered edit must be accompanied by at least one oasdiff change at the same
path and method.

When oasdiff reports nothing and the text differs, the existing doc-only
fallback still applies: patch for a doc-only difference, MAJOR otherwise.

## 7. Empirical validation

`src/version/location-coverage.oasdiff.test.ts` runs a table of
(location × keyword × change) fixtures through the **real** pinned oasdiff
binary. It skips, with a reason, only when the binary is unavailable; CI has
it. Each fixture sits on its own path, so one oasdiff run judges many
fixtures, and each report is attributed by path. The test fails if Speckify
calls any fixture's edits covered but oasdiff reported nothing for that
fixture. The table crosses six placements (request body, response body, query
parameter, `deepObject` parameter, response header and callback body) with
fourteen nestings and every schema change the claims name, in both OpenAPI
3.0 and 3.1. It adds operation-level and document-level changes. At the
time of writing that is 13,485 fixtures. Speckify calls 3,191 of them
covered, and oasdiff reported on every one of those 3,191. The other 10,294
are uncovered and bump MAJOR; oasdiff reported nothing at all for 8,346 of
them. A fixture must produce at least one edit, so the table cannot
silently empty itself.

It also runs every reviewer scenario through `computeContractPlan`,
each paired with an unrelated optional response property, and expects
MAJOR. Its controls are: a covered request-body property `maxLength`
tightening gives oasdiff's MAJOR, a description-only edit gives PATCH, and
an unchanged spec gives none.

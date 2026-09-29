# The version gate: an allow-list of safe change shapes

Speckify's version bump must never under-count a breaking change. Earlier
designs let oasdiff's rule labels decide the bump and then patched the
places where those labels were missing or wrong. Every review cycle found
another such place: a keyword oasdiff does not judge at some location, a
narrowing it labels as a widening, a subtree its `allOf` flattening drops.
A deny-list of known holes cannot be shown complete.

This design inverts the default. Speckify diffs the two specs itself and
judges every structural edit against a short allow-list of change shapes
known to be safe for an existing, correctly-written client:

- a documentation-only difference is **patch**;
- an edit matching an allow-list rule is **minor**;
- **every other edit is major**, whatever oasdiff says about it.

oasdiff still runs. It writes the changelog, and its classification can
raise the bump, never lower it:

```text
bump = max(allow-list bump, oasdiff classification bump, toolchain impact)
```

A new kind of safe change gets minor only by being added to the list below,
with a test proving it compatible in both generated SDKs. Forgetting to add
one over-bumps. It never under-bumps.

## 1. Preparing the two documents

Both documents are prepared the same way before diffing
(`structural-diff.ts`, `prepareDocument`):

1. `info.version` is normalised to the `0.0.0` placeholder.
2. Documentation-only keys are stripped in annotation position: `description`,
   `summary`, `example`, `examples` and `externalDocs`. So are the root `tags`
   list and `info.contact`, `info.license`, `info.termsOfService` and
   `info.title`. A schema's `title` is not stripped: a generator can name a
   class after it, so editing one can rename a public type.
   A key is in annotation position unless it is a member name of a name map.
   A property called `title` is data, and so is everything inside a
   `default`, `const` or `enum` value.
3. Every local `$ref` outside `components` is inlined in place. Each edit then
   surfaces at its full concrete location, at every place the component is
   used. Operation parameters are addressed as `in:name`.
4. An inlined component schema carries a `$refTarget` marker naming it. Pointing a
   `$ref` at a different component, or replacing an inline schema with a
   `$ref`, renames a generated SDK type. It shows up as an edit to that
   marker, which no rule allows.
5. A `$ref` on a reference cycle is left as `{ $ref }`, and its component is
   marked cyclic. So is a `$ref` that cannot be resolved. `$ref`s inside a
   vendor extension are not inlined, because an extension is opaque.
6. Sibling keys next to a `$ref` are kept under `$refSiblings`, which no rule
   allows.

## 2. Edits

The diff emits one **edit** per change. An edit has a concrete location (a
list of segments), an action, and the before and after values.

| Value at the location                                     | Actions                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| member of a name map or keyed list (property, path, ...)  | `add`, `remove`                                                     |
| list of scalars (`enum`, `required`, `type`, op `tags`)   | `add` / `remove` per member                                         |
| number                                                    | `set`, `unset`, `increase`, `decrease`                              |
| boolean                                                   | `set` (became true), `unset` (was true), `change` (absent ↔ false) |
| string or any other value (`default`, `const`, `$ref`...) | `set`, `unset`, `change`                                            |
| the order of an operation's parameters                    | `reorder`                                                           |

A vendor extension key (`x-...` in keyword position, not a name such as a
header called `x-request-id`) is one opaque edit flagged as an extension.
An extension edit is judged by the `extension` rule alone, so it is patch
or major, never minor.

Components are judged where they are used. A content change to a component
that is referenced on both sides, and is not cyclic, emits nothing itself:
its use sites carry it. Any other component change (an unreferenced
component, or a cyclic one) emits one edit at `components.<kind>.<name>`.

## 3. Direction

The same change can be safe for a client in one direction and breaking in the
other. Relaxing `maxLength` lets a client send more, which is safe. In a
response, it means a client can receive more than it was built for.

Every edit's direction is read from its concrete location:

| Location                                                                           | Direction |
| ---------------------------------------------------------------------------------- | --------- |
| `paths.<p>[.<method>].parameters.<in:name>...`                                     | request   |
| `paths.<p>.<method>.requestBody...`                                                | request   |
| `paths.<p>.<method>.responses.<code>.content...`, `...responses.<code>.headers...` | response  |
| `...callbacks...`, `webhooks...`                                                   | inverted  |
| anything else                                                                      | none      |

A component reachable from both sides is inlined at both, so one component
change becomes one edit per use site. Each edit is judged on its own, so the
change is minor only when it is allowed in **every** direction it reaches.
Callbacks and webhooks invert the direction, because the API sends and the
consumer receives. No v1 rule allows anything under them, so any change there
is major.

## 4. Schema positions

A schema rule applies only at a **plain position**. That is a schema reached
from the parameter, body or header schema root through `properties.<name>`,
`items`, `allOf.<i>` and `additionalProperties` alone. Under these, relaxing
one subschema only relaxes the whole.

Under `anyOf`, `oneOf`, `not`, `if`/`then`/`else`, `prefixItems`,
`contains`, `dependentSchemas` or anything else, relaxing a subschema can
narrow the whole. A value can match a second `oneOf` branch, or fail a
`not`. So no schema rule matches there.

## 5. The rules

Documentation-only (**patch**):

| Rule        | Matches                                                           | Why it is safe                               |
| ----------- | ----------------------------------------------------------------- | -------------------------------------------- |
| `doc-only`  | the specs differ only in the stripped annotation keys of §1       | nothing a client sends, receives or compiles |
| `extension` | an edit to a vendor extension that no pinned generator reads (§6) | no effect on the wire or on generated code   |

The allow-list (**minor**):

| Rule                               | Direction | Matches                                                                                                                                                                                                                                                                                                          | Why it is safe                               |
| ---------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `operation-added`                  | none      | a new path, or a new method on an existing path                                                                                                                                                                                                                                                                  | no existing call can reach it                |
| `optional-parameter-added`         | request   | a new query, header or cookie parameter, `required` absent or false, not shadowing a path-level one                                                                                                                                                                                                              | existing calls omit it and stay valid        |
| `request-optional-property-added`  | request   | a new property at a plain position, not listed in its object's `required`, whose object declared no `additionalProperties` catch-all (absent or `false`)                                                                                                                                                         | existing bodies omit it and stay valid       |
| `request-constraint-relaxed`       | request   | at a plain position: `maxLength`/`maxItems`/`maximum`/`exclusiveMaximum` raised or removed; `minLength`/`minItems`/`minimum`/`exclusiveMinimum` lowered or removed; `pattern` removed; a value added to an existing `enum`; a member removed from `required`; `additionalProperties` `false` → `true` or removed | every request valid before is still valid    |
| `parameter-became-optional`        | request   | a query, header or cookie parameter's `required` true → false or removed                                                                                                                                                                                                                                         | existing calls still send it                 |
| `response-optional-property-added` | response  | a new property at a plain position, not in its object's `required`, whose object did not forbid additional properties                                                                                                                                                                                            | clients ignore a field they do not know      |
| `response-optional-header-added`   | response  | a new response header, `required` absent or false                                                                                                                                                                                                                                                                | clients ignore a header they do not know     |
| `unreferenced-schema-added`        | none      | a new `components.schemas` entry that nothing references                                                                                                                                                                                                                                                         | adds a generated type, changes none          |
| `deprecated-set`                   | any       | `deprecated` becomes true on an operation, a parameter, or a property at a plain position                                                                                                                                                                                                                        | an announcement; nothing changes on the wire |

Everything else is **major**. That includes, deliberately:

- a new request constraint, including a new `anyOf`, `oneOf`, `not`, `if`,
  an added `allOf` branch or a new `enum`;
- any relaxation in a response;
- anything in a callback or webhook;
- `servers`, `security` and security schemes;
- a renamed operation, tag or `$ref` target;
- a parameter reorder, and any keyword not named above.

New rules need a test proving the change compatible in both generated SDKs.

Two rules accept a known edge. A new optional request property constrains a
name that was previously an unconstrained additional property. A client that
sent that name with another type is now rejected. Generated SDKs never send
undeclared properties, so the rule stands as the owner decided it. It stops
at a declared catch-all: when the object has `additionalProperties: true` or
a schema, the SDK types an index signature, SDK-typed code may already send
the name, and the new property is major. `deprecated`
set without a sunset date is minor here; oasdiff's
`...-deprecated-sunset-missing` rules then raise it to major through the max.

## 6. Vendor extensions

An extension edit is patch unless a pinned generator reads the extension.
Those are major: `x-enum-varnames`, `x-enumNames` and `x-nullable`, for
example, change generated code. The list lives in `allow-list.ts`
(`SDK_EXTENSIONS`, `SDK_EXTENSION_PREFIXES`). A test scans the pinned
`@hey-api/openapi-ts`, `openapi-python-client` and `datamodel-code-generator`
sources for every `x-` literal and fails if one is missing from it. A
generator upgrade that starts reading a new extension fails the build rather
than shipping a patch.

## 7. Differences the diff cannot see

When there are no edits, or every edit is `extension` patch, the specs are
compared once more with annotations and extensions stripped. If they still
differ, the diff has missed something, such as a reordered `enum`. The bump
is then major, not patch. Identical normalised specs publish nothing.

## 8. oasdiff

oasdiff runs on every plan, always with `--flatten-allof`. Its changes are
classified by the committed classification map (`classification-map.ts`),
where an unknown rule id counts as major. That bump joins the max, and the
changes become the changelog. oasdiff failing aborts the plan: it never
defaults to a bump.

## 9. How it is proven

- `allow-list.test.ts`: each rule is minor alone. The same shape in the
  other direction is major. A shared component edit reaching both sides is
  major unless allowed for both.
- `allow-list.property.test.ts`: two generators. The first is a matrix of
  every schema change × placement × nesting, run through the real diff. The
  second is a seeded random generator of synthetic edits over keywords,
  locations and actions. Both assert that nothing an independent oracle
  calls unsafe is ever judged below major.
- `version-gate.scenarios.test.ts`: every under-bump found in review cycles
  1-5, alone and paired with an unrelated new optional response property,
  through `computeContractPlan`. It runs against stubbed oasdiff output and
  against the real binary. It also holds the real-binary proof that
  oasdiff's major outranks the allow-list's minor.

# The generated-surface diff

The allow-list in [`../version/allow-list.md`](../version/allow-list.md)
judges the spec. It cannot see what the generators do with a spec edit. A new
schema can rename an existing generated type, and a new operation can take an
existing function's name. A new property can shift a positional argument. None
of these changes the old part of the spec, yet each one breaks a client
compiled against the published package.

So every plan with a previous version also compares the generated packages
themselves:

```text
bump = max(allow-list, oasdiff classification, toolchain impact, client surface bump)
```

A first publish has nothing to compare against and runs no surface diff.

**Only the client surface drives the bump.** Every bump in this file — the
allow-list, the classification map, the toolchain-impact check — is judged
from the point of view of an existing, correctly-written **client** of the
API (`docs/versioning.md`, the classification map's own header). A generated
server package is not that: nobody publishes a compiled artifact against it
the way an SDK consumer does. It's regenerated and rebuilt by the one
producer who wrote the spec change, in the same PR, so a break there is
caught by that producer's own build, never shipped to a third party frozen
against an old version. Feeding a server-only break into `max()` used to
over-bump: a new operation always adds a method to the TypeScript `Handlers`
interface and the Python `Handlers` `Protocol`, which §2's own rule (a
`Protocol` gaining a member is major) makes major — so a purely additive
change looked like a breaking one.

So the surface diff is computed once, over both halves, and then split by
where each change landed:

- the **client surface** — TS's `.`, `./types` and `./zod` entry points;
  Python's client and models modules — sets `report.bump`, exactly as
  before;
- the **server surface** — TS's `./server` entry point; Python's
  `<package>.server` module tree — is still compared, in full, but only
  **reported**: `report.serverChanges`, and a "Server changes" section in
  the changelog/PR comment. It never reaches `max()`.

A change that touches neither surface doesn't exist: every generated symbol
is exactly one or the other.

## 1. What is compared

1. The previous bundled spec is read from the previous published package, as
   the plan already does.
2. Both specs are generated with the **current** toolchain, the same pinned
   generators and options a build uses, into a temporary directory. The
   previous package is regenerated rather than downloaded. The comparison then
   isolates what the spec edit did to the surface. What a toolchain upgrade does
   to the surface is the toolchain-impact bump's job.
3. Each language the contract requests is compared, including the server half
   when the contract generates one.
4. Two identical specs (once `info.version` is normalised) are not generated
   at all. The same spec through the same pinned toolchain generates the same
   surface, so the report is none.

The bundled spec is canonical, key-sorted JSON. Reordering a schema's
`properties` in the source therefore changes neither the bundle nor any
generated code, and the surface diff correctly reports nothing. The `tags`
list keeps its order, so a tag reorder regenerates the Python client into a
different module and is caught as a removed module.

Symbols are compared through each language's own structural model and never by
matching generated source text:

- TypeScript through the compiler's `TypeChecker`;
- Python through [griffe](https://mkdocstrings.github.io/griffe/)'s object
  tree, which loads a package statically from its AST. The toolchain pins
  `griffelib==2.3.0`, the library without the command-line tool. It is ISC
  licensed and maintained by the mkdocstrings project.

## 2. Verdicts

Each language reports a list of changes, each **minor** or **major**. The
surface bump is the highest of them: **none** when the two surfaces are
identical, never patch.

| Change                                                      | Bump  |
| ----------------------------------------------------------- | ----- |
| an entry point, module or exported name removed             | major |
| a symbol changed kind (type to value, function to class)    | major |
| a property or attribute removed from a type or class        | major |
| a type changed incompatibly for the direction it is used in | major |
| a call that compiled or ran before no longer does (§4)      | major |
| a class consumers implement (a `Protocol`) gains a member   | major |
| an entry point, module or exported name added               | minor |
| any other difference                                        | minor |

## 3. TypeScript

`typescript.ts` builds one `ts.Program` over both packages' emitted `.d.ts`
entry points. Those are the `types` files named in each `package.json`
`exports` map. Loading both packages into one program lets a single checker
relate a previous type to a current one. For each entry point it takes the
exports with `checker.getExportsOfModule`.

For each exported symbol it records:

- its kind (type, value, or both);
- a structural description built from the checker's `Type` objects:
  properties with optionality and `readonly`, call signatures with parameter
  optionality, order and rest, return types, index signatures, and unions as
  unordered sets. A named type inside another is recorded as a reference by
  name, and is compared as its own export.

Two identical descriptions mean no change. Otherwise compatibility is judged
with `checker.isTypeAssignableTo`, public since TypeScript 5.x. It is the
checker's own assignability relation, so no type rules are reimplemented here.
A synthesised assertion file would reach the same relation, but through
diagnostics that would have to be read back.

Direction comes from use. The walk starts at every exported value, with
parameters as **input** and return types as **output**. It follows named
types, type arguments, properties and nested signatures, and flips direction
at each parameter. A type reached as input must accept everything it accepted
before (`previous` assignable to `current`). One reached as output must not
produce anything new (`current` assignable to `previous`). A type reached both
ways, or never reached, needs both. Exported values themselves are output: the
consumer receives the value and calls it.

TypeScript assignability ignores properties the target does not declare, so a
removed property is also checked structurally. Removing a property breaks any
object literal or read that names it, whatever the direction.

The zod schemas are compared by what they validate. Each exported zod schema's
`z.output<typeof schema>` type is read through a small synthesised module in a
second pass of the same program. Its direction is the direction of the
generated TypeScript type with the identical structure. When there is none,
the schema needs mutual assignability.

## 4. Python

`python/extract_surface.py` loads the generated package with griffe and prints
a JSON model. `python.ts` compares two such models.

- **Modules**: every module whose dotted path has no `_`-prefixed part.
- **Public names**: `__all__` when the module declares it. Otherwise every
  member defined in the module (not imported) without a leading underscore.
- **Functions**: parameters with kind (positional-only, positional or keyword,
  keyword-only, `*args`, `**kwargs`), whether they have a default, and
  annotations. The return annotation is recorded too.
- **Classes**: bases, public methods, attributes and a constructor
  signature. An explicit `__init__` is used as written. An attrs class
  (openapi-python-client) takes its fields in declaration order as
  positional-or-keyword parameters, omitting `init=False` fields. A pydantic
  model (datamodel-code-generator) takes its fields as keyword-only
  parameters, named by their alias when they have one.
- **Annotations**: griffe's expression tree, with names resolved to canonical
  paths and `Optional`, `Union` and `|` flattened to one unordered union.

A call that ran before must still run:

- a removed parameter, or one that lost its default, is major;
- a positional parameter that changed position, or became keyword-only, is major;
- a new parameter without a default is major, and one with a default is minor.

Direction follows the TypeScript rule. Public function parameters are input
and return annotations output. A class inherits every direction it is reached
in through annotations. A `Protocol` flips direction, because consumers
implement it. An annotation may widen as input and narrow as output, compared
as a set of union members. Any other change to an annotation is major. A
class reached only as output is constructed by the SDK, not the consumer, so
its constructor order is not judged.

## 5. Cost

Generation runs twice per plan: previous and current, both languages side by
side. The TypeScript comparison builds two programs, the second reusing the
first. The Python extraction is one `uv run` per side.

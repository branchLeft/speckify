# Versioning

A published contract never gets a version a human typed. This is the
whole point: the number reflects what actually changed on the wire, not
what someone remembered to bump.

## The pipeline

For each contract, on every `speckify check` or `speckify publish` run:

1. **Bundle.** External `$ref`s are inlined into one canonical JSON
   document (`src/bundle`), so the diff step always compares one
   complete document against another, never a document plus whatever its
   `$ref` targets happened to contain at diff time.
2. **Lint.** The bundled spec is checked against a small, deliberately
   strict rule set (`src/lint`) _before_ anything else runs — an
   unsupported OpenAPI version, a missing or duplicate `operationId`, or
   a `patternProperties` schema fails the build immediately, rather than
   quietly producing a version, or a generated package, for a spec no
   generator can actually turn into working code.
3. **Fetch the last published state.** Speckify asks the registry itself
   — GitHub Packages for the npm package, PyPI for the Python package —
   for the newest version, then downloads that release and extracts the
   `openapi.json` published alongside it. **The registry is the record**,
   not git tags, not a changelog file: whatever the registry says was
   last published is authoritative, full stop. If a contract publishes to
   both languages and they've drifted (one language failed to publish on
   a previous run), the higher of the two versions wins as the baseline.
4. **Diff.** The last-published spec and the freshly bundled one are
   compared with a pinned build of [`oasdiff`](https://github.com/oasdiff/oasdiff)
   (`src/oasdiff`), always with `--flatten-allof`: without it, oasdiff
   compares `allOf` branches one at a time and can under-report severity,
   because a change that's unsafe in one branch might in principle be
   masked by another. Flattening first compares what the branches
   describe _together_ — what a client actually receives.
5. **Classify.** Every reported change is looked up in a committed
   classification map (`data/oasdiff-<version>.classification.json`),
   judged from the perspective of an existing, correctly-written
   **client** of the API — the side that doesn't control the change:

   - **`major`** — could make a correct existing client fail: request
     narrowing, a response change a client may not be prepared to handle,
     anything that invalidates a security requirement or credential.
   - **`minor`** — backward-compatible additions, and an announced
     (sunset-dated) deprecation.
   - **`patch`** — no effect on the wire contract at all: a description,
     example, or tag change where the generated SDK surface is
     unchanged.
   - **No entry in the map at all → `major`.** This is a deliberate
     fail-safe, not an omission to fix later: a rule oasdiff can report
     that nobody has ever judged is exactly the case where guessing wrong
     downward would be worst. The map is meant to be completed over time
     as new rule ids are seen; until then, unclassified means "assume the
     worst."

   One case sits outside oasdiff's own rule set entirely: if oasdiff
   reports **no** semantic changes but the bundled spec's text still
   differs from what was last published (a description tweak that
   doesn't move any rule id), that's treated as `patch` — the contract
   did change, even if nothing about the wire behaviour did.

6. **Bump and stamp.** The highest-severity bump found — across every
   oasdiff rule matched, plus any bump Speckify's own toolchain forces on
   every consumer between releases (`src/version/toolchain-impact.ts`,
   for the rare case a Speckify release itself changes what "the same
   contract" means) — is applied to the last published version.
   **A contract that has never been published always starts at `1.0.0`**,
   regardless of what the diff says, because there's nothing to diff
   against yet and a `0.x` series would tell consumers "not stable"
   when the whole mechanism exists to make every published version
   exactly that.

## Why `operationId` and tag renames are `major`, not `patch`

Read purely as a wire contract, renaming an `operationId` or a tag
changes nothing a client sends or receives. But the generators Speckify
targets (`openapi-typescript`/`hey-api`-style clients, `openapi-python-client`,
`oazapfts`) turn `operationId` and tag groupings directly into the
_names_ of generated methods and modules. A rename there breaks every
generated call site at compile time, even though the HTTP traffic is
identical — so the classification map judges both as `major`, deliberately
departing from what a pure protocol-level reading would say.

## Extending the classification map

Adding a new `oasdiff` rule id is a reviewed, evidence-based decision,
not a mechanical one: it needs the rule's own oasdiff level, which
direction it applies to (request/response/neither), and a one-line
reason recorded alongside the bump it's given. See
`data/oasdiff-<version>.classification.json` and
`src/version/classification-map-completeness.test.ts`, which fails the
build if oasdiff's own rule catalogue ever grows a rule id the map
doesn't cover — the alternative (finding out at classification time, on
someone's real PR) is worse.

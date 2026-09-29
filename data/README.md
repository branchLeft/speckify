# `data/`

The files here are JSON (plus one licence text) because they are read by
Speckify itself at runtime and by its tests, not edited by hand from day to
day — treat a change to any of them as a change to Speckify's behaviour, not
a docs tweak.

## `oasdiff-1.32.1.checks.json`

The verbatim output of the pinned [oasdiff](https://github.com/oasdiff/oasdiff)
1.32.1 binary's `oasdiff checks changelog --format json`: oasdiff's own
catalogue of the 755 rules its changelog can ever report, each with its
`id`, `level`, `direction`, `area`, `kind`, `actions`, `effect`, `locations`
and `description`. Speckify wrote none of it — it is third-party content
from the oasdiff project, licensed Apache License 2.0 (see
[`LICENSE-oasdiff`](LICENSE-oasdiff) in this directory).

**Regenerating it**: run the pinned oasdiff binary's `checks changelog
--format json` and overwrite this file with the result. It should only ever
change when `OASDIFF_VERSION` (`src/oasdiff/version.ts`) is bumped.
`src/version/classification-map-completeness.test.ts` compares this
committed file against what the real, live binary reports today, whenever a
binary is available to the test run, so a stale catalogue fails the build
rather than going unnoticed.

**Licensing note**: oasdiff's repository carries no `NOTICE` file at the
`v1.32.1` tag, so there is nothing beyond the licence text itself to
reproduce. Its `LICENSE` (the standard Apache-2.0 form, unmodified) is
copied verbatim into [`LICENSE-oasdiff`](LICENSE-oasdiff) per §4 of that
licence. Copyright in the oasdiff source belongs to its own contributors
(see the [oasdiff repository](https://github.com/oasdiff/oasdiff)); nothing
in this directory asserts Speckify authorship over this file.

## `oasdiff-1.32.1.classification.json`

Mixed provenance — this file is not one thing:

- The `oasdiffVersion` header, and each rule's `id`, `oasdiffLevel`,
  `direction` and `effect` columns, were extracted from oasdiff's own
  source at the `v1.32.1` tag (`checker/rules.go` and the individual rule
  definitions it registers). These columns describe oasdiff's own rule,
  not Speckify's opinion of it, and are covered by the same oasdiff
  attribution as `oasdiff-1.32.1.checks.json` above — see
  [`LICENSE-oasdiff`](LICENSE-oasdiff).
- The `perspective` header and every rule's `bump` and `reason` are
  Speckify's own judgement, MIT-licensed like the rest of this repository:
  what that oasdiff rule means for an existing, correctly-written client of
  a versioned contract. Each row was drafted by an AI model (Claude Sonnet
  5) reading the rule's check source, then reviewed by another (Claude
  Opus 5.5), which changed 62 rows before the file was committed.
- `source` records which oasdiff Go source file the row's judgement was
  read from, so a judgement can be checked against where it came from
  rather than only trusted.

**Its role today**: one of four inputs Speckify's version plan combines by
`max()` — allow-list, this classification map, toolchain impact, and the
generated client-surface diff (`src/surface/surface.md`, `src/plan.md`) —
so a classification can only raise the final bump, never lower it. Any
rule id oasdiff declares that this map has no entry for is treated as
`major` by default, and
`src/version/classification-map-completeness.test.ts` fails the build the
moment the pinned oasdiff binary's catalogue grows a rule id this file
doesn't cover.

**Extending it**: see ["Extending the classification
map"](../docs/versioning.md#extending-the-classification-map) in
`docs/versioning.md` — adding a rule id is a reviewed, evidence-based
decision, not a mechanical one.

## `toolchain-impact.json`

Speckify's own record of what each of *its own* released versions did to
every consumer's generated surface, independent of any spec change — a
generator upgrade that renames a method, for instance. Each entry is
`{ speckifyVersion, impact }`, and `impact` joins the same `max()` as the
allow-list, the oasdiff classification and the client-surface diff.

Add an entry when a Speckify release changes the pinned code generators, the
naming rules they're driven with, or anything else that can alter a
generated package's public surface independently of the spec it was
generated from — not for a release that only changes Speckify's own
internals with no effect on generated output.

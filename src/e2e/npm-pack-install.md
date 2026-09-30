# Published npm package test

## Why this test exists

This test proves the _published_ package actually starts and runs, not just the repo's own checkout.

`pnpm install` in this repo hoists every devDependency into `node_modules` too, so a runtime import of a package only declared as a devDependency (or a symlink built from this repo's own `node_modules` layout) passes every other test here while being unusable once installed for real. A consumer's `npm install speckify` never fetches devDependencies, and speckify's own working directory does not exist inside their `node_modules` tree.

## Why it's slow and gated

The test is slow (a real `npm pack`, a real `npm install` from the tarball, and — when `uv` is on PATH — a real `speckify build` running the pinned Python toolchain) and needs network.

It is gated the same way `built-cli.test.ts` is, so it still runs for real in CI rather than being silently skipped there, while staying skippable offline.

# speckify

Speckify bundles a producer repo's OpenAPI spec, computes the semver bump from
an `oasdiff` diff against the last version published to the registry, and
generates TypeScript and Python client/server packages.

## Status

Phase 1 of the build: configuration, bundling, the registry record, version
classification and the `oasdiff` runner. Codegen and publishing land in a
later phase.

<!-- TODO: quickstart -->

<!-- TODO: speckify.yaml reference -->

<!-- TODO: CLI reference (speckify check / speckify plan) -->

<!-- TODO: how the version is computed -->

## Development

```sh
nvm use
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

## Licence

MIT, see [LICENSE](./LICENSE).

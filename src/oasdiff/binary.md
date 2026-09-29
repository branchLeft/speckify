# Resolving the oasdiff binary

`resolveOasdiffBinary` (in `binary.ts`) tries three sources, in order, and
stops at the first that succeeds:

1. **`SPECKIFY_OASDIFF` env var.** Unconditionally trusted — set by whoever
   controls the environment, so no checksum check applies here.
2. **The version's cache directory** (`<cacheDir>/<OASDIFF_VERSION>/oasdiff`).
   A prior resolution already verified this binary; re-verifying it on every
   call would cost a hash of the whole file for no benefit.
3. **A fresh download from the GitHub release**, matched against the
   checksum committed in `checksums.json` before it is written to the cache
   or ever executed. A mismatch throws `OasdiffError` rather than running an
   unverified binary.

Downloading is the expensive, security-sensitive path; the other two exist
so a CI run or a developer's second `speckify` invocation never has to take
it.

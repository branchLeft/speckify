# Resolving the oasdiff binary

`resolveOasdiffBinary` (in `binary.ts`) tries three sources, in order, and
stops at the first that succeeds. **Every source is checksum-verified on
every call** against `binary-checksums.json` -- the extracted binary's own
SHA-256, not the release archive's -- so a tampered cache or a tampered
override can never run silently.

1. **`SPECKIFY_OASDIFF` env var.** Verified against `binary-checksums.json`
   for the host platform/arch on every call, unless
   `SPECKIFY_OASDIFF_UNVERIFIED=1` is set, in which case the check is
   skipped and a warning is printed instead -- for a locally built binary
   that will never match the committed table.
2. **The version's cache directory** (`<cacheDir>/<OASDIFF_VERSION>/oasdiff`).
   Re-hashed on every call and compared to the committed table. A mismatch
   is treated as a tampered cache: the file is discarded and resolution
   falls through to a fresh download, rather than trusting or silently
   overwriting it.
3. **A fresh download from the GitHub release**, matched against the
   archive checksum committed in `checksums.json`, then the extracted
   binary is matched against `binary-checksums.json` before it is written
   to the cache or ever executed. Either mismatch throws `OasdiffError`
   rather than running an unverified binary. The download is written to a
   temp file in the cache's version directory and atomically renamed into
   place, so a reader can never observe a partially written binary.

## Two checksum tables

oasdiff's release only publishes SHA-256 sums for the release **archives**
(mirrored in `checksums.json`). Verifying the binary on every use needs a
checksum of the **extracted binary itself**, computed ahead of time and
committed to `binary-checksums.json` -- re-downloading and re-extracting the
archive on every invocation just to re-derive that hash would defeat the
point of caching.

`binary-checksums.json` is generated (and, after a version bump,
regenerated) by `scripts/compute-oasdiff-binary-checksums.mjs`, which
downloads each release archive, verifies it against the already-committed
`checksums.json` (so a compromised download here cannot poison the binary
table), extracts the binary, and hashes that.

Downloading is the expensive, security-sensitive path; the cache and the
override exist so a CI run or a developer's second `speckify` invocation
never has to take it -- but every path still pays for one file hash per
call.

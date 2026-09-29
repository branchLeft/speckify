import { describe, expect, it } from 'vitest';

import { verifyActionPins } from './verify-action-pins.mjs';

// B8: every `uses:` pin claims a SHA is what its tag comment points to.
// This resolves each one against the real repo and fails if any pin
// drifted or -- as astral-sh/setup-uv's and reviewdog/action-actionlint's
// both did -- was never right in the first place (an annotated tag's own
// object SHA, not the commit it dereferences to). Skips, rather than
// falsely passing, when there is no network to check against.
describe('verifyActionPins', () => {
  it('every uses: pin in action.yml and .github/workflows matches its tagged commit', async () => {
    const result = await verifyActionPins();
    if (result.skipped) {
      console.log(`verify-action-pins: skipped (${result.reason})`);
      return;
    }
    expect(result.mismatches).toEqual([]);
  }, 30_000);
});

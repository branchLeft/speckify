/** The last thing Speckify published for one package: its version and the exact spec it shipped. */
export interface RegistryRecordEntry {
  version: string;
  /** The canonical JSON of the bundled spec published alongside that version. */
  bundledSpec: string;
  /**
   * The Speckify toolchain version that generated this published package,
   * read back from the package itself (npm: `package.json`'s
   * `speckify.speckifyVersion`; PyPI: the `speckify.json` package-data
   * file). `null` when the package predates that field, or otherwise does
   * not carry it -- an *unknown* generating version, which callers must
   * treat as a fail-safe case, never as "never generated before".
   */
  speckifyVersion: string | null;
}

/**
 * The registry is the record, not git tags: this is the seam every version
 * and publish decision reads from. `latest` resolves to `null` when the
 * package has never been published, never by throwing.
 */
export interface RegistryRecord {
  latest(packageName: string): Promise<RegistryRecordEntry | null>;
}

/** The subset of the global `fetch` signature Speckify's registry clients use. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The last thing Speckify published for one package: its version and the exact spec it shipped. */
export interface RegistryRecordEntry {
  version: string;
  /** The canonical JSON of the bundled spec published alongside that version. */
  bundledSpec: string;
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

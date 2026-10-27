import type { FetchLike } from './types.js';

export interface DeadlineFetch {
  /** One request, aborted if no response arrives within the timeout. */
  fetch(what: string, url: string): Promise<Response>;
  /** Reads a response body, which the same timeout also bounds (a stalled body aborts the signal). */
  body<T>(what: string, url: string, read: () => Promise<T>): Promise<T>;
}

/**
 * Wraps a fetch implementation so every request and body read runs under one
 * deadline. A stall or abort is re-raised through `fail`, so each module keeps
 * its own error type; the message names the URL.
 */
export function deadlineFetch(
  fetchImpl: FetchLike,
  timeoutMs: number,
  fail: (message: string) => Error,
): DeadlineFetch {
  return {
    async fetch(what: string, url: string): Promise<Response> {
      try {
        return await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        throw fail(`${what} from ${url} failed: ${reasonOf(error)}`);
      }
    },
    async body<T>(what: string, url: string, read: () => Promise<T>): Promise<T> {
      try {
        return await read();
      } catch (error) {
        throw fail(`${what} from ${url} could not be read: ${reasonOf(error)}`);
      }
    },
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

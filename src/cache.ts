//! Single-value TTL cache with single-flight dedup and stale-on-error
//! fallback.
//!
//! There is no CDN in front of this service (the original Lambda relied on
//! CloudFront honoring Cache-Control). Without an in-process cache, every
//! request — including a burst from a price-aggregator poll loop — would
//! hit the Solana RPC directly, which is the slowest and most rate-limited
//! part of the stack. This cache absorbs that: at most one upstream fetch
//! is ever in flight, and a transient RPC failure serves the last good
//! value instead of a 500.

export interface TtlCache<T> {
  /** Returns a fresh-enough value, refreshing in the background/foreground
   *  as needed. Throws only if no value has ever been fetched successfully. */
  get(): Promise<T>;
  /** Diagnostics for the /health endpoint. */
  status(): { hasValue: boolean; ageMs: number | null; lastErrorMessage: string | null };
}

export function createTtlCache<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  ttlMs: number,
  timeoutMs: number,
): TtlCache<T> {
  let value: T | undefined;
  let fetchedAtMs = 0;
  let inFlight: Promise<T> | null = null;
  let lastErrorMessage: string | null = null;

  async function refresh(): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    const fresh = await fetcher(signal);
    value = fresh;
    fetchedAtMs = Date.now();
    lastErrorMessage = null;
    return fresh;
  }

  return {
    async get(): Promise<T> {
      const isFresh = value !== undefined && Date.now() - fetchedAtMs < ttlMs;
      if (isFresh) {
        return value as T;
      }

      if (!inFlight) {
        inFlight = refresh().finally(() => {
          inFlight = null;
        });
      }

      try {
        return await inFlight;
      } catch (err) {
        lastErrorMessage = err instanceof Error ? err.message : String(err);
        // Stale-on-error: serve the last known-good value rather than
        // failing the request, as long as we have ever fetched one.
        if (value !== undefined) {
          return value;
        }
        throw err;
      }
    },
    status() {
      return {
        hasValue: value !== undefined,
        ageMs: value !== undefined ? Date.now() - fetchedAtMs : null,
        lastErrorMessage,
      };
    },
  };
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTtlCache } from "./cache.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createTtlCache", () => {
  it("fetches once and reuses the value within the TTL", async () => {
    let calls = 0;
    const cache = createTtlCache(async () => {
      calls += 1;
      return calls;
    }, 10_000, 1000);

    assert.equal(await cache.get(), 1);
    assert.equal(await cache.get(), 1);
    assert.equal(calls, 1);
  });

  it("refetches once the TTL has elapsed", async () => {
    let calls = 0;
    const cache = createTtlCache(async () => {
      calls += 1;
      return calls;
    }, 1, 1000);

    assert.equal(await cache.get(), 1);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await cache.get(), 2);
  });

  it("single-flights concurrent misses into one upstream call", async () => {
    let calls = 0;
    const d = deferred<number>();
    const cache = createTtlCache(async () => {
      calls += 1;
      return d.promise;
    }, 10_000, 1000);

    const a = cache.get();
    const b = cache.get();
    d.resolve(7);
    assert.deepEqual(await Promise.all([a, b]), [7, 7]);
    assert.equal(calls, 1);
  });

  it("serves the last good value when a refresh fails (stale-on-error)", async () => {
    let calls = 0;
    const cache = createTtlCache(async () => {
      calls += 1;
      if (calls === 1) return "good";
      throw new Error("rpc down");
    }, 1, 1000);

    assert.equal(await cache.get(), "good");
    await new Promise((r) => setTimeout(r, 5));
    // TTL elapsed, refresh fails, but we still have a value to fall back to.
    assert.equal(await cache.get(), "good");
    assert.equal(cache.status().lastErrorMessage, "rpc down");
  });

  it("throws if the very first fetch fails (no fallback value exists)", async () => {
    const cache = createTtlCache(async () => {
      throw new Error("rpc down");
    }, 10_000, 1000);

    await assert.rejects(() => cache.get(), /rpc down/);
    assert.equal(cache.status().hasValue, false);
  });

  it("reports cache status for /health", async () => {
    const cache = createTtlCache(async () => "v", 10_000, 1000);
    assert.deepEqual(cache.status(), {
      hasValue: false,
      ageMs: null,
      lastErrorMessage: null,
    });
    await cache.get();
    const status = cache.status();
    assert.equal(status.hasValue, true);
    assert.ok(status.ageMs !== null && status.ageMs < 1000);
  });
});

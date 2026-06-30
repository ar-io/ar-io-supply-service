import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

// `./app.js` reads config at module-init time; none of it is required, but
// keep LOG_LEVEL quiet for test output. Same pattern as the attestor's
// app.test.ts.
process.env.LOG_LEVEL ??= "silent";
process.env.CACHE_TTL_SECONDS ??= "60";

const { default: app } = await import("./app.js");

function writeU64LE(buf: Buffer, offset: number, value: bigint): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt(8 * i)) & 0xffn);
  }
}

function buildAccountsResponse() {
  const config = Buffer.alloc(200);
  writeU64LE(config, 136, 1_000_000_000_000_000n); // total
  writeU64LE(config, 152, 900_000_000_000_000n); // circulating
  writeU64LE(config, 160, 50_000_000_000_000n); // locked

  const gar = Buffer.alloc(300);
  writeU64LE(gar, 253, 10_000_000_000_000n); // staked
  writeU64LE(gar, 261, 5_000_000_000_000n); // delegated
  writeU64LE(gar, 269, 1_000_000_000_000n); // withdrawn

  const token = Buffer.alloc(80);
  writeU64LE(token, 64, 2_000_000_000_000n); // protocolBalance

  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      value: [config, gar, token].map((buf) => ({
        data: [buf.toString("base64"), "base64"],
      })),
    },
  };
}

// The app's outgoing Solana RPC call and this test file's own HTTP calls
// to the local test server both resolve to the same global `fetch`.
// Mocking `globalThis.fetch` therefore intercepts BOTH — capture the real
// implementation first and use it for client-side requests in these tests.
const realFetch = globalThis.fetch.bind(globalThis);

describe("GET /token/supply, /token/supply/:attribute, /health", () => {
  let baseUrl: string;
  let server: import("node:http").Server;
  let fetchMock: ReturnType<typeof mock.method>;

  before(async () => {
    fetchMock = mock.method(globalThis, "fetch", async () => {
      return new Response(JSON.stringify(buildAccountsResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    fetchMock.mock.restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /token/supply returns the full supply object denominated in ARIO", async () => {
    const res = await realFetch(`${baseUrl}/token/supply`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 1_000_000_000);
    assert.equal(body.staked, 10_000_000);
    assert.equal(body.liquid, 900_000_000);
    // circulating = total - lockedBeforeCutoff; with no pre-cutoff buckets
    // unlocked in the future relative to "now" in this fixture-free test,
    // it's simply <= total.
    assert.ok(body.circulating <= body.total);
    assert.match(res.headers.get("cache-control") ?? "", /max-age=60/);
  });

  it("GET /token/supply/:attribute returns a bare scalar for a known field", async () => {
    const res = await realFetch(`${baseUrl}/token/supply/staked`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body, 10_000_000);
  });

  it("GET /token/supply/:attribute 404s for an unknown field", async () => {
    const res = await realFetch(`${baseUrl}/token/supply/notarealfield`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.message, /not found/);
  });

  it("GET / (bare root) 404s — only /token/supply is a valid path", async () => {
    const res = await realFetch(`${baseUrl}/`);
    assert.equal(res.status, 404);
  });

  it("GET /health reports cache status", async () => {
    // Hit /token/supply once first so the cache has a value.
    await realFetch(`${baseUrl}/token/supply`);
    const res = await realFetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.cache.hasValue, true);
  });

  it("only calls the Solana RPC once across repeated requests within the TTL", async () => {
    await realFetch(`${baseUrl}/token/supply`);
    await realFetch(`${baseUrl}/token/supply/circulating`);
    await realFetch(`${baseUrl}/token/supply/staked`);
    assert.equal(fetchMock.mock.callCount(), 1);
  });
});

describe("rate limiting keys per real client, not per proxy hop", () => {
  it("treats requests with different X-Forwarded-For values as different clients", async () => {
    // Regression test for the "trust proxy" bug: without `app.set("trust
    // proxy", "loopback")`, Express ignores X-Forwarded-For entirely and
    // req.ip is always the connecting socket's address. Since these test
    // requests connect over loopback — the same position nginx occupies in
    // production — this exercises exactly the scenario that broke: every
    // client collapsing into one shared rate-limit bucket.
    const okFetch = mock.method(globalThis, "fetch", async () => {
      return new Response(JSON.stringify(buildAccountsResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    process.env.RATE_LIMIT_PER_MIN = "1";
    try {
      const { default: limitedApp } = await import(`./app.js?rl=${Date.now()}`);
      const server = limitedApp.listen(0);
      try {
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const { port } = server.address() as AddressInfo;
        const url = `http://127.0.0.1:${port}/token/supply`;

        const first = await realFetch(url, { headers: { "X-Forwarded-For": "1.1.1.1" } });
        assert.equal(first.status, 200);
        const secondSameClient = await realFetch(url, { headers: { "X-Forwarded-For": "1.1.1.1" } });
        assert.equal(secondSameClient.status, 429, "second request from the same client should be rate-limited");
        const differentClient = await realFetch(url, { headers: { "X-Forwarded-For": "2.2.2.2" } });
        assert.equal(differentClient.status, 200, "a different client's first request should not be rate-limited");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      delete process.env.RATE_LIMIT_PER_MIN;
      okFetch.mock.restore();
    }
  });
});

describe("GET /token/supply when the upstream RPC is down and no cache exists", () => {
  it("returns 500 with a generic message — no internal error detail (e.g. a keyed RPC URL) leaked to the client", async () => {
    const failingFetch = mock.method(globalThis, "fetch", async () => {
      throw new Error("connect ECONNREFUSED secret-rpc-api-key=abc123");
    });
    // Fresh app instance with its own cache so this test doesn't depend on
    // (or pollute) the cache populated by the suite above.
    const { default: freshApp } = await import(`./app.js?t=${Date.now()}`);
    const server = freshApp.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;

      const res = await realFetch(`http://127.0.0.1:${port}/token/supply`);
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.match(body.message, /Error retrieving supply data/);
      assert.equal(body.error, undefined);
      assert.ok(!JSON.stringify(body).includes("secret-rpc-api-key"));
    } finally {
      failingFetch.mock.restore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

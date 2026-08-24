import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  readU64LE,
  decodeSupply,
  getSupply,
  assertPlausible,
  lockedBeforeCutoff,
  MARIO_PER_ARIO,
  ARIO_MINT,
  ARIO_CONFIG_PDA,
  GAR_SETTINGS_PDA,
  PROTOCOL_TOKEN_ACCOUNT,
  type DecodedSupply,
  type LockBucket,
} from "./supply.js";

function writeU64LE(buf: Buffer, offset: number, value: bigint): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt(8 * i)) & 0xffn);
  }
}

/** Build synthetic mint/config/gar/token account buffers with values at the
 *  real on-chain offsets, so decodeSupply can be tested without a live
 *  Solana RPC. `total` is written to the mint's `supply` field;
 *  `declaredTotal` to the frozen ArioConfig.total_supply the service must
 *  NOT use (defaults to a round 1B so tests prove the two are distinct). */
function buildAccounts(values: {
  total: bigint;
  declaredTotal?: bigint;
  circulating: bigint;
  locked: bigint;
  staked: bigint;
  delegated: bigint;
  withdrawn: bigint;
  protocolBalance: bigint;
}) {
  const mint = Buffer.alloc(82);
  writeU64LE(mint, 36, values.total);

  const config = Buffer.alloc(200);
  writeU64LE(config, 136, values.declaredTotal ?? 1_000_000_000_000_000n);
  writeU64LE(config, 152, values.circulating);
  writeU64LE(config, 160, values.locked);

  const gar = Buffer.alloc(300);
  writeU64LE(gar, 253, values.staked);
  writeU64LE(gar, 261, values.delegated);
  writeU64LE(gar, 269, values.withdrawn);

  const token = Buffer.alloc(80);
  writeU64LE(token, 64, values.protocolBalance);

  return { mint, config, gar, token };
}

describe("readU64LE", () => {
  it("round-trips small and large values", () => {
    const buf = Buffer.alloc(16);
    writeU64LE(buf, 0, 42n);
    writeU64LE(buf, 8, 1_000_000_000_000n);
    assert.equal(readU64LE(buf, 0), 42);
    assert.equal(readU64LE(buf, 8), 1_000_000_000_000);
  });
});

describe("decodeSupply", () => {
  it("reads all fields from the correct byte offsets", () => {
    const accounts = buildAccounts({
      total: 1_000_000_000_000_000n,
      declaredTotal: 1_000_000_000_000_000n,
      circulating: 900_000_000_000_000n,
      locked: 50_000_000_000_000n,
      staked: 10_000_000_000_000n,
      delegated: 5_000_000_000_000n,
      withdrawn: 1_000_000_000_000n,
      protocolBalance: 2_000_000_000_000n,
    });
    const decoded = decodeSupply(accounts);
    assert.deepEqual(decoded, {
      total: 1_000_000_000_000_000,
      circulating: 900_000_000_000_000,
      locked: 50_000_000_000_000,
      staked: 10_000_000_000_000,
      delegated: 5_000_000_000_000,
      withdrawn: 1_000_000_000_000,
      protocolBalance: 2_000_000_000_000,
    });
  });

  it("throws if an account is too small for the layout", () => {
    const accounts = buildAccounts({
      total: 1n,
      circulating: 1n,
      locked: 1n,
      staked: 1n,
      delegated: 1n,
      withdrawn: 1n,
      protocolBalance: 1n,
    });
    accounts.config = accounts.config.subarray(0, 100);
    assert.throws(() => decodeSupply(accounts), /ArioConfig too small/);
  });

  it("throws if the mint account is too small for the SPL Mint layout", () => {
    const accounts = buildAccounts({
      total: 1n,
      circulating: 1n,
      locked: 1n,
      staked: 1n,
      delegated: 1n,
      withdrawn: 1n,
      protocolBalance: 1n,
    });
    accounts.mint = accounts.mint.subarray(0, 40);
    assert.throws(() => decodeSupply(accounts), /ARIO mint too small/);
  });

  it("takes total from the mint's live supply, not the frozen ArioConfig declaration", () => {
    // Mainnet as of 2026-08-12: two holders burned 373.297318 ARIO via a
    // wallet-cleanup incinerator, so the mint sits below the 1B declaration.
    const accounts = buildAccounts({
      total: 999_999_626_702_682n,
      declaredTotal: 1_000_000_000_000_000n,
      circulating: 567_086_326_895_261n,
      locked: 350_741_549_431_956n,
      staked: 9_078_395_040_320n,
      delegated: 14_179_387_872_094n,
      withdrawn: 6_582_063_966_524n,
      protocolBalance: 117_314_107_725_836n,
    });

    const decoded = decodeSupply(accounts);

    assert.equal(decoded.total, 999_999_626_702_682);
    assert.notEqual(
      decoded.total,
      1_000_000_000_000_000,
      "must not report the genesis declaration",
    );
  });
});

describe("assertPlausible", () => {
  const base: DecodedSupply = {
    total: 1_000_000_000 * MARIO_PER_ARIO,
    circulating: 900_000_000 * MARIO_PER_ARIO,
    locked: 50_000_000 * MARIO_PER_ARIO,
    staked: 10_000_000 * MARIO_PER_ARIO,
    delegated: 5_000_000 * MARIO_PER_ARIO,
    withdrawn: 1_000_000 * MARIO_PER_ARIO,
    protocolBalance: 2_000_000 * MARIO_PER_ARIO,
  };

  it("accepts a plausible supply snapshot", () => {
    assert.doesNotThrow(() => assertPlausible(base));
  });

  it("rejects a total far outside the expected 900M-1.1B ARIO range", () => {
    assert.throws(
      () => assertPlausible({ ...base, total: 1 }),
      /Implausible total supply/,
    );
  });

  it("rejects a negative field", () => {
    assert.throws(
      () => assertPlausible({ ...base, staked: -1 }),
      /Implausible staked/,
    );
  });

  it("rejects a field larger than total", () => {
    assert.throws(
      () => assertPlausible({ ...base, locked: base.total + 1 }),
      /Implausible locked/,
    );
  });
});

describe("lockedBeforeCutoff", () => {
  const buckets: LockBucket[] = [
    { endTimestamp: 1000, balance: 100 },
    { endTimestamp: 2000, balance: 200 },
    { endTimestamp: 3000, balance: 300 },
  ];

  it("sums only buckets whose unlock date is still in the future", () => {
    assert.equal(lockedBeforeCutoff(1500, buckets), 500); // 2000 + 3000
    assert.equal(lockedBeforeCutoff(2500, buckets), 300); // 3000 only
    assert.equal(lockedBeforeCutoff(3500, buckets), 0); // all unlocked
    assert.equal(lockedBeforeCutoff(0, buckets), 600); // all still locked
  });

  it("treats endTimestamp equal to now as unlocked (strict >)", () => {
    assert.equal(lockedBeforeCutoff(2000, buckets), 300);
  });
});

describe("getSupply", () => {
  // Mainnet values as of 2026-08-12: the mint holds 999,999,626.702682 ARIO
  // after two holder burns, while ArioConfig still declares a round 1B.
  const LIVE_TOTAL_MARIO = 999_999_626_702_682n;
  const accounts = buildAccounts({
    total: LIVE_TOTAL_MARIO,
    declaredTotal: 1_000_000_000_000_000n,
    circulating: 567_086_326_895_261n,
    locked: 350_741_549_431_956n,
    staked: 9_078_395_040_320n,
    delegated: 14_179_387_872_094n,
    withdrawn: 6_582_063_966_524n,
    protocolBalance: 117_314_107_725_836n,
  });

  function rpcResponse(): Response {
    const value = [
      accounts.mint,
      accounts.config,
      accounts.gar,
      accounts.token,
    ].map((buf) => ({ data: [buf.toString("base64"), "base64"] }));
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  it("requests the mint alongside the three PDAs in one getMultipleAccounts", async (t) => {
    let requested: unknown;
    t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
      requested = JSON.parse(String(args[1]?.body)).params[0];
      return rpcResponse();
    });

    await getSupply("http://rpc.test", new AbortController().signal);

    assert.deepEqual(requested, [
      ARIO_MINT,
      ARIO_CONFIG_PDA,
      GAR_SETTINGS_PDA,
      PROTOCOL_TOKEN_ACCOUNT,
    ]);
  });

  it("serves the live mint supply as total and propagates it into circulating", async (t) => {
    t.mock.method(globalThis, "fetch", async () => rpcResponse());

    const supply = await getSupply("http://rpc.test", new AbortController().signal);

    assert.equal(supply.total, 999_999_626.702682, "total = live mint supply");
    assert.ok(
      supply.total < 1_000_000_000,
      "total must sit below the 1B declaration once tokens have been burned",
    );
    // circulating stays "total minus the pre-cutoff vesting still locked", so
    // the burn flows straight through to it.
    assert.equal(
      supply.circulating,
      (Number(LIVE_TOTAL_MARIO) - lockedBeforeCutoff(Date.now())) /
        MARIO_PER_ARIO,
    );
    // liquid remains the strict on-chain ArioConfig.circulating_supply.
    assert.equal(supply.liquid, 567_086_326.895261);
  });

  it("reports genesis as the historical 1B, independent of live supply", async (t) => {
    t.mock.method(globalThis, "fetch", async () => rpcResponse());

    const supply = await getSupply(
      "http://rpc.test",
      new AbortController().signal,
    );

    assert.equal(supply.genesis, 1_000_000_000);
    // genesis - total surfaces the burned amount (373.297318 ARIO). Compared
    // with a tolerance because subtracting two ~1e9 float64 values loses the
    // low digits: the exact difference comes out as 373.29731798171997. Both
    // served values are themselves exact to the mARIO.
    assert.ok(
      Math.abs(supply.genesis - supply.total - 373.297318) < 1e-6,
      `unexpected burned amount: ${supply.genesis - supply.total}`,
    );
  });

  it("exposes exactly the documented response fields", async (t) => {
    t.mock.method(globalThis, "fetch", async () => rpcResponse());

    const supply = await getSupply(
      "http://rpc.test",
      new AbortController().signal,
    );

    assert.deepEqual(Object.keys(supply), [
      "total",
      "genesis",
      "circulating",
      "locked",
      "staked",
      "delegated",
      "withdrawn",
      "protocolBalance",
      "liquid",
    ]);
  });
});

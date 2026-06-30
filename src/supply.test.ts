import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  readU64LE,
  decodeSupply,
  assertPlausible,
  lockedBeforeCutoff,
  MARIO_PER_ARIO,
  type DecodedSupply,
  type LockBucket,
} from "./supply.js";

function writeU64LE(buf: Buffer, offset: number, value: bigint): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt(8 * i)) & 0xffn);
  }
}

/** Build synthetic config/gar/token account buffers with values at the
 *  real on-chain offsets, so decodeSupply can be tested without a live
 *  Solana RPC. */
function buildAccounts(values: {
  total: bigint;
  circulating: bigint;
  locked: bigint;
  staked: bigint;
  delegated: bigint;
  withdrawn: bigint;
  protocolBalance: bigint;
}) {
  const config = Buffer.alloc(200);
  writeU64LE(config, 136, values.total);
  writeU64LE(config, 152, values.circulating);
  writeU64LE(config, 160, values.locked);

  const gar = Buffer.alloc(300);
  writeU64LE(gar, 253, values.staked);
  writeU64LE(gar, 261, values.delegated);
  writeU64LE(gar, 269, values.withdrawn);

  const token = Buffer.alloc(80);
  writeU64LE(token, 64, values.protocolBalance);

  return { config, gar, token };
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

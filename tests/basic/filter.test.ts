import { describe, expect, test } from "bun:test";
import { hexToBytes, bytesToHex } from "../../src/crypto/bytes.ts";
import {
  buildBasicFilter,
  displayHashToInternal,
  matchAnyBasicFilters,
} from "../../src/basic/filter.ts";

// Official BIP-158 genesis vector (testnet genesis block, height 0):
// Block Hash (display/RPC order) and the sole coinbase output script
// (the famous P2PK "pubkey" script) — hardcoded here per Task 5 scope;
// full block decoding lands in Task 6.
const GENESIS_BLOCK_HASH_DISPLAY_HEX =
  "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943";
const GENESIS_OUTPUT_SCRIPT_HEX =
  "4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac";
const GENESIS_FILTER_HEX = "019dfca8";

describe("displayHashToInternal", () => {
  test("reverses byte order", () => {
    const display = hexToBytes(
      "0000000000000000000000000000000000000000000000000000000000000001",
    );
    expect(bytesToHex(displayHashToInternal(display))).toBe(
      "0100000000000000000000000000000000000000000000000000000000000000",
    );
  });

  test("rejects hashes that are not 32 bytes", () => {
    expect(() => displayHashToInternal(hexToBytes("0011223344"))).toThrow();
  });

  test("round-trips under double reversal", () => {
    const display = hexToBytes(GENESIS_BLOCK_HASH_DISPLAY_HEX);
    const roundTripped = displayHashToInternal(displayHashToInternal(display));
    expect(roundTripped).toEqual(display);
  });
});

describe("buildBasicFilter", () => {
  test("matches the official genesis filter vector", () => {
    const blockHashDisplay = hexToBytes(GENESIS_BLOCK_HASH_DISPLAY_HEX);
    const elements = [hexToBytes(GENESIS_OUTPUT_SCRIPT_HEX)];
    const filterBytes = buildBasicFilter({ blockHashDisplay, elements });
    expect(bytesToHex(filterBytes)).toBe(GENESIS_FILTER_HEX);
  });

  test("omits a zero-length element", () => {
    const blockHashDisplay = hexToBytes(GENESIS_BLOCK_HASH_DISPLAY_HEX);
    const script = hexToBytes(GENESIS_OUTPUT_SCRIPT_HEX);
    const withEmpty = buildBasicFilter({
      blockHashDisplay,
      elements: [script, new Uint8Array()],
    });
    const withoutEmpty = buildBasicFilter({
      blockHashDisplay,
      elements: [script],
    });
    expect(withEmpty).toEqual(withoutEmpty);
  });

  test("omits zero-length elements while retaining GCS deduplication", () => {
    const blockHashDisplay = new Uint8Array(32).fill(7);
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5, 6]);
    const uniqueNonempty = buildBasicFilter({
      blockHashDisplay,
      elements: [first, second],
    });
    const mixed = buildBasicFilter({
      blockHashDisplay,
      elements: [
        first,
        new Uint8Array(),
        first,
        new Uint8Array(),
        second,
      ],
    });

    expect(mixed).toEqual(uniqueNonempty);
  });
});

describe("matchAnyBasicFilters", () => {
  const blockHashDisplay = hexToBytes(GENESIS_BLOCK_HASH_DISPLAY_HEX);
  const script = hexToBytes(GENESIS_OUTPUT_SCRIPT_HEX);
  const filterBytes = buildBasicFilter({
    blockHashDisplay,
    elements: [script],
  });

  const hashA = new Uint8Array(32).fill(0x11);
  const hashB = new Uint8Array(32).fill(0x22);
  const hit = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(9)]);
  const miss = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(1)]);
  const filterHit = buildBasicFilter({
    blockHashDisplay: hashA,
    elements: [hit],
  });
  const filterMiss = buildBasicFilter({
    blockHashDisplay: hashB,
    elements: [miss],
  });

  test("matches the official genesis filter against its coinbase script", () => {
    expect(bytesToHex(filterBytes)).toBe(GENESIS_FILTER_HEX);
    expect(
      matchAnyBasicFilters([filterBytes], [blockHashDisplay], [script]),
    ).toEqual([true]);
  });

  test("rejects an absent element", () => {
    const absent = new TextEncoder().encode("not-in-the-genesis-filter");
    expect(
      matchAnyBasicFilters([filterBytes], [blockHashDisplay], [absent]),
    ).toEqual([false]);
  });

  test("rejects a present element queried under the wrong block hash", () => {
    const wrongHash = new Uint8Array(32).fill(0xaa);
    expect(
      matchAnyBasicFilters([filterBytes], [wrongHash], [script]),
    ).toEqual([false]);
  });

  test("returns a boolean per filter for a shared watchlist", () => {
    expect(
      matchAnyBasicFilters(
        [filterHit, filterMiss],
        [hashA, hashB],
        [hit],
      ),
    ).toEqual([true, false]);
  });

  test("single filter: true when any queried element is present", () => {
    const absent = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(1)]);
    expect(
      matchAnyBasicFilters([filterHit], [hashA], [absent, hit]),
    ).toEqual([true]);
  });

  test("single filter: false when no queried element is present", () => {
    expect(matchAnyBasicFilters([filterHit], [hashA], [miss])).toEqual([false]);
  });

  test("empty watchlist yields all-false", () => {
    expect(
      matchAnyBasicFilters([filterHit, filterMiss], [hashA, hashB], []),
    ).toEqual([false, false]);
  });

  test("rejects filter/hash length mismatch", () => {
    expect(() =>
      matchAnyBasicFilters([filterHit], [hashA, hashB], [hit]),
    ).toThrow(/filter\/hash length mismatch/);
  });

  test("rejects a non-32-byte display hash", () => {
    expect(() =>
      matchAnyBasicFilters([filterHit], [new Uint8Array(16)], [hit]),
    ).toThrow(/display hash must be 32 bytes/);
  });
});

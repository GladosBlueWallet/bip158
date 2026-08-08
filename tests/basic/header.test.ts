import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, bytesToHex } from "../../src/crypto/bytes.ts";
import { displayHashToInternal } from "../../src/basic/filter.ts";
import { filterHash, filterHeader } from "../../src/basic/header.ts";

// Official BIP-158 genesis vector (testnet genesis block, height 0), from the
// btcd/BIP test-vector generator (`gentestvectors.go`): filter headers are
// `chainhash.Hash` values, whose `.String()` reverses bytes for display —
// exactly like a block hash. The hex below is that *display* string, so it
// must be reversed to get the internal bytes our SHA256d chain operates on.
const GENESIS_FILTER_HEX = "019dfca8";
const GENESIS_PREV_HEADER_HEX = "0".repeat(64);
const GENESIS_HEADER_DISPLAY_HEX =
  "21584579b7eb08997773e5aeff3a7f932700042d0ed2a6129012b7d7ae81b750";

function sha256dIndependent(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

describe("filterHash", () => {
  test("matches independent SHA256d of the serialized filter bytes", () => {
    const filterBytes = hexToBytes(GENESIS_FILTER_HEX);
    expect(filterHash(filterBytes)).toEqual(sha256dIndependent(filterBytes));
  });

  test("hashes empty and non-empty payloads (not just length)", () => {
    const empty = filterHash(new Uint8Array());
    const one = filterHash(new Uint8Array([0x00]));
    expect(empty).toEqual(sha256dIndependent(new Uint8Array()));
    expect(one).toEqual(sha256dIndependent(new Uint8Array([0x00])));
    expect(empty).not.toEqual(one);
  });
});

describe("filterHeader", () => {
  test("matches the genesis vector header from an all-zero previous header", () => {
    const filterBytes = hexToBytes(GENESIS_FILTER_HEX);
    const prevHeader = hexToBytes(GENESIS_PREV_HEADER_HEX); // all-zero: reversal is a no-op
    const header = filterHeader(filterHash(filterBytes), prevHeader);
    expect(bytesToHex(displayHashToInternal(header))).toBe(
      GENESIS_HEADER_DISPLAY_HEX,
    );
  });

  test("is SHA256d(filterHash || prevHeader) against an independent digester", () => {
    const filterHashBytes = hexToBytes(
      "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    );
    const prevHeader = hexToBytes(
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    );
    const concatenated = new Uint8Array(64);
    concatenated.set(filterHashBytes, 0);
    concatenated.set(prevHeader, 32);

    expect(filterHeader(filterHashBytes, prevHeader)).toEqual(
      sha256dIndependent(concatenated),
    );
  });

  for (const length of [0, 8, 31, 33]) {
    test(`rejects a ${length}-byte filter hash`, () => {
      expect(() =>
        filterHeader(new Uint8Array(length), new Uint8Array(32)),
      ).toThrow(`filter hash must be 32 bytes, got ${length}`);
    });

    test(`rejects a ${length}-byte previous header`, () => {
      expect(() =>
        filterHeader(new Uint8Array(32), new Uint8Array(length)),
      ).toThrow(`previous header must be 32 bytes, got ${length}`);
    });
  }
});

import { describe, expect, test } from "bun:test";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
} from "../../src/crypto/bytes.ts";

describe("hexToBytes", () => {
  test("parses mixed-case hex", () => {
    expect(hexToBytes("DeAdBeEf")).toEqual(
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    );
  });

  test("rejects non-hex and odd length", () => {
    expect(() => hexToBytes("gg")).toThrow("invalid hex string");
    expect(() => hexToBytes("abc")).toThrow("odd hex length");
  });
});

describe("bytesToHex", () => {
  test("round-trips with hexToBytes and lowercases", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(bytesToHex(bytes)).toBe("deadbeef");
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });
});

describe("concatBytes", () => {
  test("concatenates and leaves inputs unchanged", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3]);
    expect(concatBytes(a, b)).toEqual(new Uint8Array([1, 2, 3]));
    expect(concatBytes()).toEqual(new Uint8Array());
    expect(a).toEqual(new Uint8Array([1, 2]));
  });
});

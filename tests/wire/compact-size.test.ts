import { describe, expect, test } from "bun:test";
import { bytesToHex } from "../../src/crypto/bytes.ts";
import * as publicApi from "../../src/index.ts";
import * as compactSize from "../../src/wire/compact-size.ts";

type BigIntDecodeResult = { value: bigint; length: number };
type BigIntDecoder = (
  bytes: Uint8Array,
  offset?: number,
) => BigIntDecodeResult;

const { decodeCompactSize, encodeCompactSize } = compactSize;

function decodeCompactSizeBigInt(
  bytes: Uint8Array,
  offset = 0,
): BigIntDecodeResult {
  const decoder = (
    compactSize as typeof compactSize & {
      decodeCompactSizeBigInt?: BigIntDecoder;
    }
  ).decodeCompactSizeBigInt;
  if (decoder === undefined) {
    throw new Error("decodeCompactSizeBigInt is not implemented");
  }
  return decoder(bytes, offset);
}

describe("encodeCompactSize", () => {
  test.each([
    [0n, "00"],
    [0xfcn, "fc"],
    [0xfdn, "fdfd00"],
    [0xffffn, "fdffff"],
    [0x1_0000n, "fe00000100"],
    [0xffff_ffffn, "feffffffff"],
    [0x1_0000_0000n, "ff0000000001000000"],
    [0xffff_ffff_ffff_ffffn, "ffffffffffffffffff"],
  ] as const)("encodes prefix boundary %s canonically", (value, expected) => {
    expect(bytesToHex(encodeCompactSize(value))).toBe(expected);
  });

  test("accepts safe integer number inputs", () => {
    const encoded = encodeCompactSize(Number.MAX_SAFE_INTEGER);
    expect(decodeCompactSize(encoded).value).toBe(Number.MAX_SAFE_INTEGER);
  });

  test.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid number input %s", (value) => {
    expect(() => encodeCompactSize(value)).toThrow();
  });

  test.each([-1n, 0x1_0000_0000_0000_0000n])(
    "rejects bigint outside uint64: %s",
    (value) => {
      expect(() => encodeCompactSize(value)).toThrow();
    },
  );
});

describe("decodeCompactSizeBigInt", () => {
  test.each([
    [new Uint8Array([0xfc]), 0xfcn, 1],
    [new Uint8Array([0xfd, 0xfd, 0x00]), 0xfdn, 3],
    [new Uint8Array([0xfd, 0xff, 0xff]), 0xffffn, 3],
    [new Uint8Array([0xfe, 0x00, 0x00, 0x01, 0x00]), 0x1_0000n, 5],
    [
      new Uint8Array([0xfe, 0xff, 0xff, 0xff, 0xff]),
      0xffff_ffffn,
      5,
    ],
    [
      new Uint8Array([0xff, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]),
      0x1_0000_0000n,
      9,
    ],
    [
      new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      0xffff_ffff_ffff_ffffn,
      9,
    ],
  ] as const)(
    "decodes every canonical prefix boundary",
    (bytes, value, length) => {
      expect(decodeCompactSizeBigInt(bytes)).toEqual({ value, length });
    },
  );

  test.each([
    new Uint8Array([0xfd, 0xfc, 0x00]),
    new Uint8Array([0xfd, 0x01, 0x00]),
    new Uint8Array([0xfe, 0xff, 0xff, 0x00, 0x00]),
    new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]),
  ])("rejects noncanonical encoding %#j", (bytes) => {
    expect(() => decodeCompactSizeBigInt(bytes)).toThrow(/canonical/i);
    expect(() => decodeCompactSize(bytes)).toThrow(/canonical/i);
  });

  test.each([
    new Uint8Array(),
    new Uint8Array([0xfd]),
    new Uint8Array([0xfd, 0xfd]),
    new Uint8Array([0xfe, 0x00, 0x00, 0x01]),
    new Uint8Array([0xff, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]),
  ])("rejects truncated input %#j", (bytes) => {
    expect(() => decodeCompactSizeBigInt(bytes)).toThrow(/end/i);
  });

  test("supports a valid nonzero offset", () => {
    const bytes = new Uint8Array([0xaa, 0xfd, 0xfd, 0x00, 0xbb]);
    expect(decodeCompactSizeBigInt(bytes, 1)).toEqual({
      value: 0xfdn,
      length: 3,
    });
  });

  test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid offset %s",
    (offset) => {
      expect(() =>
        decodeCompactSizeBigInt(new Uint8Array([0x00]), offset),
      ).toThrow(/offset/i);
      expect(() =>
        decodeCompactSize(new Uint8Array([0x00]), offset),
      ).toThrow(/offset/i);
    },
  );
});

describe("decodeCompactSize", () => {
  test("retains exact number results through MAX_SAFE_INTEGER", () => {
    const encoded = encodeCompactSize(BigInt(Number.MAX_SAFE_INTEGER));
    expect(decodeCompactSize(encoded)).toEqual({
      value: Number.MAX_SAFE_INTEGER,
      length: 9,
    });
  });

  test("rejects decoded values above MAX_SAFE_INTEGER", () => {
    const encoded = encodeCompactSize(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(() => decodeCompactSize(encoded)).toThrow(/safe integer/i);
    expect(decodeCompactSizeBigInt(encoded).value).toBe(
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    );
  });
});

describe("public CompactSize API", () => {
  test("exports number encode/decode from the package root", () => {
    expect(publicApi.encodeCompactSize).toBeFunction();
    expect(publicApi.decodeCompactSize).toBeFunction();
    expect(publicApi.decodeCompactSize(publicApi.encodeCompactSize(0x100))).toEqual({
      value: 0x100,
      length: 3,
    });
  });

  test("keeps the bigint decoder internal (not re-exported)", () => {
    expect(
      "decodeCompactSizeBigInt" in publicApi,
    ).toBe(false);
  });
});

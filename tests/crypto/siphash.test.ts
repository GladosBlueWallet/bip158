import { describe, expect, test } from "bun:test";
import { hashToRange, siphash24 } from "../../src/crypto/siphash.ts";

function seqBytes(n: number): Uint8Array {
  return new Uint8Array(Array.from({ length: n }, (_, i) => i));
}

const SIPHASH24_REFERENCE_VECTORS = [
  0x726fdb47dd0e0e31n,
  0x74f839c593dc67fdn,
  0x0d6c8009d9a94f5an,
  0x85676696d7fb7e2dn,
  0xcf2794e0277187b7n,
  0x18765564cd99a68dn,
  0xcbc9466e58fee3cen,
  0xab0200f58b01d137n,
  0x93f5f5799a932462n,
  0x9e0082df0ba9e4b0n,
  0x7a5dbbc594ddb9f3n,
  0xf4b32f46226bada7n,
  0x751e8fbc860ee5fbn,
  0x14ea5627c0843d90n,
  0xf723ca908e7af2een,
  0xa129ca6149be45e5n,
  0x3f2acc7f57c29bdbn,
  0x699ae9f52cbe4794n,
  0x4bc1b3f0968dd39cn,
  0xbb6dc91da77961bdn,
  0xbed65cf21aa2ee98n,
  0xd0f2cbb02e3b67c7n,
  0x93536795e3a33e88n,
  0xa80c038ccd5ccec8n,
  0xb8ad50c6f649af94n,
  0xbce192de8a85b8ean,
  0x17d835b85bbb15f3n,
  0x2f2e6163076bcfadn,
  0xde4daaaca71dc9a5n,
  0xa6a2506687956571n,
  0xad87a3535c49ef28n,
  0x32d892fad841c342n,
  0x7127512f72f27ccen,
  0xa7f32346f95978e3n,
  0x12e0b01abb051238n,
  0x15e034d40fa197aen,
  0x314dffbe0815a3b4n,
  0x027990f029623981n,
  0xcadcd4e59ef40c4dn,
  0x9abfd8766a33735cn,
  0x0e3ea96b5304a7d0n,
  0xad0c42d6fc585992n,
  0x187306c89bc215a9n,
  0xd4a60abcf3792b95n,
  0xf935451de4f21df2n,
  0xa9538f0419755787n,
  0xdb9acddff56ca510n,
  0xd06c98cd5c0975ebn,
  0xe612a3cb9ecba951n,
  0xc766e62cfcadaf96n,
  0xee64435a9752fe72n,
  0xa192d576b245165an,
  0x0a8787bf8ecb74b2n,
  0x81b3e73d20b49b6fn,
  0x7fa8220ba3b2ecean,
  0x245731c13ca42499n,
  0xb78dbfaf3a8d83bdn,
  0xea1ad565322a1a0bn,
  0x60e61c23a3795013n,
  0x6606d7e446282b93n,
  0x6ca4ecb15c5f91e1n,
  0x9f626da15c9625f3n,
  0xe51b38608ef25f57n,
  0x958a324ceb064572n,
] as const;

describe("siphash24", () => {
  const key = seqBytes(16);
  const message = seqBytes(64);

  test.each(
    SIPHASH24_REFERENCE_VECTORS.map(
      (expected, length) => [length, expected] as const,
    ),
  )("matches canonical vector for message length %i", (length, expected) => {
    expect(siphash24(key, message.subarray(0, length))).toBe(expected);
  });
});

describe("hashToRange", () => {
  const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

  test("uses 128-bit multiply then high 64 bits", () => {
    const key = seqBytes(16);
    const item = new Uint8Array([0x42]);
    const F = 0x100000000n;
    const v = siphash24(key, item);
    expect(hashToRange(item, F, key)).toBe((v * F) >> 64n);
  });

  test("range-reduces via the high 64 bits of the 128-bit product for F=2", () => {
    const key = seqBytes(16);
    const item = new Uint8Array([0]);
    expect(hashToRange(item, 2n, key)).toBe((siphash24(key, item) * 2n) >> 64n);
  });

  test.each([0n, -1n, UINT64_MAX + 1n])(
    "rejects F outside 1..UINT64_MAX: %s",
    (F) => {
      expect(() =>
        hashToRange(new Uint8Array(), F, seqBytes(16)),
      ).toThrow(/F|range|uint64/i);
    },
  );

  test("accepts UINT64_MAX", () => {
    const result = hashToRange(new Uint8Array([0x42]), UINT64_MAX, seqBytes(16));
    expect(result).toBeGreaterThanOrEqual(0n);
    expect(result).toBeLessThan(UINT64_MAX);
  });

  test.each([0, 15, 17])(
    "validates the SipHash key for callers when length is %i",
    (length) => {
      expect(() =>
        hashToRange(new Uint8Array(), 1n, new Uint8Array(length)),
      ).toThrow(/16 bytes/i);
    },
  );
});

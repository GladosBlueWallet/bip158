import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { hexToBytes } from "../../src/crypto/bytes.ts";
import {
  buildGcs,
  deserializeGcs,
  matchAnyGcs,
  matchGcs,
  parseGcs,
  serializeGcs,
  validateGcs,
} from "../../src/gcs/gcs.ts";

function key16(seed: number): Uint8Array {
  return new Uint8Array(Array.from({ length: 16 }, (_, i) => (seed + i) & 0xff));
}

function item(label: string): Uint8Array {
  return new TextEncoder().encode(label);
}

const KEY = key16(1);
const P = 19;
const M = 784931n;
const EMPTY_FILTER = {
  N: 0,
  P: 0,
  M: 1n,
  data: new Uint8Array(),
};
const VALID_DOMAIN_CASES = [
  ["P=0, M=1", 0, 1n],
  ["P=1, M=2", 1, 2n],
  ["P=7, M=128", 7, 128n],
  ["P=19, M=784931", 19, 784931n],
  ["P=31, M=4294967295", 31, 0xffff_ffffn],
  ["P=32, M=4294967295", 32, 0xffff_ffffn],
] as const;

describe("buildGcs / serializeGcs / deserializeGcs", () => {
  test("empty filter serializes as single 0x00 byte", () => {
    const filter = buildGcs({ items: [], key: KEY, P, M });
    expect(filter.N).toBe(0);
    const bytes = serializeGcs(filter);
    expect(bytes).toEqual(new Uint8Array([0x00]));
  });

  test("round-trips a small set of items through serialize/deserialize", () => {
    const items = [item("alpha"), item("bravo"), item("charlie")];
    const filter = buildGcs({ items, key: KEY, P, M });
    expect(filter.N).toBe(3);

    const bytes = serializeGcs(filter);
    const decoded = deserializeGcs(bytes, { P, M });

    expect(decoded.N).toBe(filter.N);
    expect(decoded.P).toBe(filter.P);
    expect(decoded.M).toBe(filter.M);
    expect(decoded.data).toEqual(filter.data);
  });

  test("deduplicates identical items (byte equality)", () => {
    const items = [item("dup"), item("dup"), item("unique")];
    const filter = buildGcs({ items, key: KEY, P, M });
    expect(filter.N).toBe(2);
  });

  test("large N produces a multi-byte CompactSize prefix", () => {
    const items = Array.from({ length: 300 }, (_, i) => item(`item-${i}`));
    const filter = buildGcs({ items, key: KEY, P, M });
    expect(filter.N).toBe(300);
    const bytes = serializeGcs(filter);
    // CompactSize: 253 <= n <= 0xffff -> 0xfd prefix + 2-byte LE
    expect(bytes[0]).toBe(0xfd);
    expect(bytes[1]).toBe(300 & 0xff);
    expect(bytes[2]).toBe((300 >> 8) & 0xff);

    const decoded = deserializeGcs(bytes, { P, M });
    expect(decoded.N).toBe(300);
  });

  test("accepts the valid P=32 boundary", () => {
    const member = item("p32-member");
    const filter = buildGcs({
      items: [member],
      key: KEY,
      P: 32,
      M: 1,
    });
    expect(filter.data).toEqual(new Uint8Array(5));

    const decoded = deserializeGcs(serializeGcs(filter), { P: 32, M: 1 });
    expect(matchGcs(decoded, KEY, member)).toBe(true);
  });
});

describe("valid-domain GCS properties", () => {
  test.each(VALID_DOMAIN_CASES)(
    "strictly round-trips and preserves matching for %s",
    (_parameters, propertyP, propertyM) => {
      const items = Array.from({ length: 37 }, (_, index) =>
        item(`valid-domain-member-${index.toString().padStart(2, "0")}`),
      );
      const absentItems = Array.from({ length: 5 }, (_, index) =>
        item(`valid-domain-absent-${index.toString().padStart(2, "0")}`),
      );

      const built = buildGcs({
        items,
        key: KEY,
        P: propertyP,
        M: propertyM,
      });
      expect(built.N).toBe(items.length);

      const serialized = serializeGcs(built);
      const decoded = deserializeGcs(serialized, {
        P: propertyP,
        M: propertyM,
      });
      expect(decoded).toEqual(built);
      expect(serializeGcs(decoded)).toEqual(serialized);

      for (const member of items) {
        expect(matchGcs(decoded, KEY, member)).toBe(true);
      }

      const querySets: Uint8Array[][] = [
        [],
        [absentItems[0]!],
        absentItems,
        [items[0]!],
        [absentItems[0]!, items[18]!, absentItems[1]!],
        [items[36]!, items[0]!, items[18]!],
        items.filter((_, index) => index % 5 === 0),
        [absentItems[4]!, absentItems[4]!, items[5]!],
      ];
      for (const queries of querySets) {
        const repeatedMatch = queries.some((query) =>
          matchGcs(decoded, KEY, query),
        );
        expect(matchAnyGcs(decoded, KEY, queries)).toBe(repeatedMatch);
      }
    },
  );
});

describe("parseGcs", () => {
  test("parses N/P/M without requiring a canonical body", () => {
    const member = item("member");
    const built = buildGcs({ items: [member], key: KEY, P: 0, M: 2 });
    const bytes = serializeGcs(built);
    const corrupt = Uint8Array.from(bytes);
    corrupt[corrupt.length - 1]! |= 0x01;

    const parsed = parseGcs(corrupt, { P: 0, M: 2 });
    expect(parsed.N).toBe(1);
    expect(parsed.P).toBe(0);
    expect(parsed.M).toBe(2n);
    expect(() => deserializeGcs(corrupt, { P: 0, M: 2 })).toThrow(
      /padding|canonical/i,
    );
    expect(matchGcs(parsed, KEY, member)).toBe(true);
  });

  test("still rejects truncated headers and oversized bodies", () => {
    expect(() => parseGcs(new Uint8Array(), { P: 0, M: 1 })).toThrow();
    const oversized = new Uint8Array(4_000_002);
    oversized[0] = 0x01;
    expect(() => parseGcs(oversized, { P: 0, M: 1 })).toThrow(
      /4.?000.?000|large|size/i,
    );
  });
});

describe("matchGcs", () => {
  const items = [item("alpha"), item("bravo"), item("charlie"), item("delta")];
  const filter = buildGcs({ items, key: KEY, P, M });

  test("matches every item used to build the filter", () => {
    for (const it of items) {
      expect(matchGcs(filter, KEY, it)).toBe(true);
    }
  });

  test("rejects an absent item", () => {
    expect(matchGcs(filter, KEY, item("absent-item-not-in-set"))).toBe(false);
  });

  test("rejects a present item under a different SipHash key", () => {
    expect(matchGcs(filter, key16(99), items[0]!)).toBe(false);
  });

  test("empty filter never matches", () => {
    const empty = buildGcs({ items: [], key: KEY, P, M });
    expect(matchGcs(empty, KEY, item("anything"))).toBe(false);
  });
});

describe("matchAnyGcs", () => {
  const items = [item("alpha"), item("bravo"), item("charlie"), item("delta")];
  const filter = buildGcs({ items, key: KEY, P, M });

  test("returns true when at least one queried item is present", () => {
    const query = [item("nope"), item("bravo"), item("still-nope")];
    expect(matchAnyGcs(filter, KEY, query)).toBe(true);
  });

  test("returns false when none of the queried items are present", () => {
    const query = [item("nope"), item("still-nope"), item("nada")];
    expect(matchAnyGcs(filter, KEY, query)).toBe(false);
  });

  test("returns false for an empty query list", () => {
    expect(matchAnyGcs(filter, KEY, [])).toBe(false);
  });
});

describe("GCS parameter and key validation", () => {
  test.each([-1, 1.5, 33])("rejects invalid P value %s centrally", (badP) => {
    expect(() => buildGcs({ items: [], key: KEY, P: badP, M: 1 })).toThrow(
      /P/,
    );
    expect(() =>
      deserializeGcs(new Uint8Array([0]), { P: badP, M: 1 }),
    ).toThrow(/P/);
    expect(() =>
      serializeGcs({ ...EMPTY_FILTER, P: badP }),
    ).toThrow(/P/);
  });

  test.each([0, -1, 0n, -1n, 0x1_0000_0000, 0x1_0000_0000n])(
    "rejects M outside 1..0xffffffff: %s",
    (badM) => {
      expect(() =>
        buildGcs({ items: [], key: KEY, P: 0, M: badM }),
      ).toThrow(/M/);
      expect(() =>
        deserializeGcs(new Uint8Array([0]), { P: 0, M: badM }),
      ).toThrow(/M/);
    },
  );

  test("rejects an unsafe numeric M before bigint conversion", () => {
    const unsafeM = Number.MAX_SAFE_INTEGER + 1;
    expect(() =>
      buildGcs({ items: [], key: KEY, P: 0, M: unsafeM }),
    ).toThrow(/safe integer/i);
    expect(() =>
      deserializeGcs(new Uint8Array([0]), { P: 0, M: unsafeM }),
    ).toThrow(/safe integer/i);
  });

  test("accepts safe numeric and bigint M values at the allowed maximum", () => {
    expect(
      buildGcs({ items: [], key: KEY, P: 0, M: 0xffff_ffff }).M,
    ).toBe(0xffff_ffffn);
    expect(
      deserializeGcs(new Uint8Array([0]), {
        P: 0,
        M: 0xffff_ffffn,
      }).M,
    ).toBe(0xffff_ffffn);
  });

  test.each([-1, 1.5, 0x1_0000_0000])(
    "rejects invalid direct-filter N value %s",
    (badN) => {
      expect(() =>
        serializeGcs({ ...EMPTY_FILTER, N: badN }),
      ).toThrow(/N|count/i);
    },
  );

  test("validates keys before every empty-operation short circuit", () => {
    const invalidKey = new Uint8Array(15);

    expect(() =>
      buildGcs({ items: [], key: invalidKey, P: 0, M: 1 }),
    ).toThrow(/16 bytes/i);
    expect(() =>
      matchGcs(EMPTY_FILTER, invalidKey, new Uint8Array()),
    ).toThrow(/16 bytes/i);
    expect(() =>
      matchAnyGcs(EMPTY_FILTER, invalidKey, []),
    ).toThrow(/16 bytes/i);
  });
});

describe("strict canonical GCS bodies", () => {
  test("accepts the canonical genesis body", () => {
    const bytes = hexToBytes("019dfca8");
    expect(serializeGcs(deserializeGcs(bytes))).toEqual(bytes);
  });

  test("rejects a noncanonical CompactSize count", () => {
    expect(() =>
      deserializeGcs(hexToBytes("fd0100"), { P: 0, M: 1 }),
    ).toThrow(/canonical/i);
  });

  test.each([
    ["empty filter with a body", "00aa", undefined],
    ["audit truncation 0d000000", "0d000000", undefined],
    ["audit truncation 0d000010", "0d000010", undefined],
    ["truncated one-item body", "01", { P: 0, M: 2 }],
    ["out-of-range cumulative value", "0180", { P: 0, M: 1 }],
    ["genesis nonzero padding", "019dfcaf", undefined],
    ["genesis excess byte", "019dfca800", undefined],
  ] as const)("rejects %s", (_name, hex, options) => {
    expect(() => deserializeGcs(hexToBytes(hex), options)).toThrow();
  });

  test.each([
    [
      "malformed empty filter",
      { ...EMPTY_FILTER, data: new Uint8Array([0]) },
    ],
    [
      "truncated body",
      { N: 1, P: 0, M: 2n, data: new Uint8Array() },
    ],
    [
      "nonzero padding",
      { N: 1, P: 0, M: 2n, data: new Uint8Array([0x01]) },
    ],
    [
      "excess byte",
      { N: 1, P: 0, M: 2n, data: new Uint8Array([0x00, 0x00]) },
    ],
    [
      "out-of-range value",
      { N: 1, P: 0, M: 1n, data: new Uint8Array([0x80]) },
    ],
  ] as const)("rejects direct %s on serialize/validate", (_name, filter) => {
    expect(() => serializeGcs(filter)).toThrow();
  });

  test("validateGcs rejects corrupt bodies; match is a fast path", () => {
    const member = item("member");
    const valid = buildGcs({ items: [member], key: KEY, P: 0, M: 2 });
    const corruptData = Uint8Array.from(valid.data);
    corruptData[corruptData.length - 1]! |= 0x01;
    const corrupt = { ...valid, data: corruptData };

    expect(() => validateGcs(corrupt)).toThrow(/padding|canonical/i);
    // Fast match may still observe the embedded value before padding bits.
    expect(matchGcs(corrupt, KEY, member)).toBe(true);
    expect(matchAnyGcs(corrupt, KEY, [member])).toBe(true);
  });

  test("deserialization clones Buffer-backed body bytes", () => {
    const source = Buffer.from([0x01, 0x00]);
    const filter = deserializeGcs(source, { P: 0, M: 2 });

    source[1] = 0xff;

    expect(filter.data).toEqual(new Uint8Array([0x00]));
    expect(filter.data).not.toBeInstanceOf(Buffer);
  });
});

describe("GCS resource limits", () => {
  test("rejects direct data larger than 4,000,000 bytes", () => {
    const filter = {
      N: 1,
      P: 0,
      M: 2n,
      data: new Uint8Array(4_000_001),
    };
    expect(() => serializeGcs(filter)).toThrow(/4.?000.?000|large|size/i);
  });

  test("rejects an oversized serialized body before cloning or decoding", () => {
    const serialized = new Uint8Array(4_000_002);
    serialized[0] = 0x01;

    expect(() =>
      deserializeGcs(serialized, { P: 0, M: 1 }),
    ).toThrow(/4.?000.?000|large|size/i);
  });

  test("rejects UINT32_MAX N when the body cannot contain that many codes", () => {
    const serialized = new Uint8Array([0xfe, 0xff, 0xff, 0xff, 0xff]);

    expect(() =>
      deserializeGcs(serialized, { P: 0, M: 1 }),
    ).toThrow(/truncated|require/i);
  });

  test("rejects an all-ones body whose Golomb value is outside F", () => {
    // Pathological unary: first bit-walk must fail closed without hanging.
    const body = new Uint8Array(4_000_000).fill(0xff);
    expect(() =>
      serializeGcs({
        N: 1,
        P: 0,
        M: 1n,
        data: body,
      }),
    ).toThrow(/outside filter range/i);
  });

  test("rejects the pathological unary build before encoding", () => {
    const moduleUrl = new URL("../../src/gcs/gcs.ts", import.meta.url).href;
    const script = `
      import { buildGcs } from ${JSON.stringify(moduleUrl)};
      try {
        buildGcs({
          items: [new Uint8Array()],
          key: new Uint8Array(16),
          P: 0,
          M: 0xffffffff,
        });
      } catch {
        process.exit(0);
      }
      process.exit(1);
    `;
    const result = spawnSync(process.execPath, ["--eval", script], {
      encoding: "utf8",
      timeout: 1_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  });
});

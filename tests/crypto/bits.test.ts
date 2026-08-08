import { describe, expect, test } from "bun:test";
import { BitReader, BitWriter, FastBitReader } from "../../src/crypto/bits.ts";

describe("BitWriter/BitReader", () => {
  test("round-trips unary-ish pattern and P-bit remainder", () => {
    const w = new BitWriter();
    // encode value 5 with P=2 → q=1,r=1 → bits 1 0 01
    w.writeBit(1);
    w.writeBit(0);
    w.writeBits(1n, 2);
    const bytes = w.finish();
    expect(bytes).toEqual(new Uint8Array([0x90]));
    const r = new BitReader(bytes);
    expect(r.readBit()).toBe(1);
    expect(r.readBit()).toBe(0);
    expect(r.readBits(2)).toBe(1n);
  });

  test("finish is idempotent", () => {
    const writer = new BitWriter();
    writer.writeBits(0b101n, 3);

    expect(writer.finish()).toEqual(new Uint8Array([0xa0]));
    expect(writer.finish()).toEqual(new Uint8Array([0xa0]));
  });

  test("finish does not corrupt writes that follow it", () => {
    const writer = new BitWriter();
    writer.writeBits(0b101n, 3);
    const first = writer.finish();

    writer.writeBit(1);

    expect(first).toEqual(new Uint8Array([0xa0]));
    expect(writer.finish()).toEqual(new Uint8Array([0xb0]));
  });

  test("reports how many bits have been consumed", () => {
    const reader = new BitReader(new Uint8Array([0xa5, 0x80]));
    expect(reader.bitsRead).toBe(0);
    expect(reader.readBits(3)).toBe(0b101n);
    expect(reader.bitsRead).toBe(3);
    expect(reader.readBits(6)).toBe(0b001011n);
    expect(reader.bitsRead).toBe(9);
  });

  test("throws when the bit stream ends early", () => {
    const reader = new BitReader(new Uint8Array([0x80]));
    expect(reader.readBit()).toBe(1);
    expect(() => reader.readBits(8)).toThrow(/unexpected end/i);
  });
});

describe("FastBitReader", () => {
  test("agrees with BitReader on the same MSB-first stream", () => {
    const writer = new BitWriter();
    writer.writeBit(1);
    writer.writeBit(0);
    writer.writeBits(0b1011n, 4);
    writer.writeBits(0n, 3);
    const bytes = writer.finish();

    const slow = new BitReader(bytes);
    const fast = new FastBitReader(bytes);
    expect(fast.readBit()).toBe(slow.readBit());
    expect(fast.readBit()).toBe(slow.readBit());
    expect(fast.readBits(4)).toBe(Number(slow.readBits(4)));
    expect(fast.readBits(3)).toBe(Number(slow.readBits(3)));
  });

  test("decodes Golomb-Rice values written by BitWriter", () => {
    // value 5, P=2 → q=1,r=1 → 1 0 01
    const writer = new BitWriter();
    writer.writeBit(1);
    writer.writeBit(0);
    writer.writeBits(1n, 2);
    // value 0, P=2 → q=0,r=0 → 0 00
    writer.writeBit(0);
    writer.writeBits(0n, 2);

    const reader = new FastBitReader(writer.finish());
    expect(reader.readGolombRice(2)).toBe(5);
    expect(reader.readGolombRice(2)).toBe(0);
  });

  test("readGolombRiceBigInt matches the number path for small values", () => {
    const writer = new BitWriter();
    // value 9, P=3 → q=1,r=1 → 1 0 001
    writer.writeBit(1);
    writer.writeBit(0);
    writer.writeBits(1n, 3);
    const bytes = writer.finish();

    expect(new FastBitReader(bytes).readGolombRice(3)).toBe(9);
    expect(new FastBitReader(bytes).readGolombRiceBigInt(3)).toBe(9n);
  });

  test("throws when Golomb-Rice unary runs off the end", () => {
    // All ones: never sees the terminating zero.
    const reader = new FastBitReader(new Uint8Array([0xff]));
    expect(() => reader.readGolombRice(2)).toThrow(/unexpected end/i);
  });
});

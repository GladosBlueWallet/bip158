/** MSB-first bit stream matching BIP-158 / btcd `write_bits_big_endian`. */
export class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private bitPos = 0;

  writeBit(b: 0 | 1): void {
    if (this.bitPos === 0) {
      this.acc = 0;
    }
    if (b) {
      this.acc |= 1 << (7 - this.bitPos);
    }
    this.bitPos++;
    if (this.bitPos === 8) {
      this.bytes.push(this.acc);
      this.bitPos = 0;
    }
  }

  /** Writes the `n` least significant bits of `value` in big-endian bit order. */
  writeBits(value: bigint, n: number): void {
    for (let i = n - 1; i >= 0; i--) {
      this.writeBit(Number((value >> BigInt(i)) & 1n) as 0 | 1);
    }
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.bytes.length + (this.bitPos === 0 ? 0 : 1));
    out.set(this.bytes);
    if (this.bitPos !== 0) {
      out[this.bytes.length] = this.acc;
    }
    return out;
  }
}

export class BitReader {
  private byteIdx = 0;
  private bitPos = 0;

  constructor(private data: Uint8Array) {}

  get bitsRead(): number {
    return this.byteIdx * 8 + this.bitPos;
  }

  readBit(): 0 | 1 {
    if (this.byteIdx >= this.data.length) {
      throw new Error("unexpected end of bit stream");
    }
    const bit = (this.data[this.byteIdx]! >> (7 - this.bitPos)) & 1;
    this.bitPos++;
    if (this.bitPos === 8) {
      this.bitPos = 0;
      this.byteIdx++;
    }
    return bit as 0 | 1;
  }

  /** Reads `n` bits as a big-endian integer (BIP-158 `read_bits_big_endian`). */
  readBits(n: number): bigint {
    let result = 0n;
    for (let i = 0; i < n; i++) {
      result = (result << 1n) | BigInt(this.readBit());
    }
    return result;
  }
}

/**
 * MSB-first bit reader for the match hot path.
 * Does not enforce canonical trailing padding.
 *
 * Uses a byte cursor (not a 32-bit shift accumulator) so P=31/32 remainders
 * are safe — JS bitwise ops are ToInt32 and cannot buffer >32 bits.
 */
export class FastBitReader {
  private readonly data: Uint8Array;
  private byteIdx = 0;
  private bitPos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  readBit(): number {
    if (this.byteIdx >= this.data.length) {
      throw new Error("unexpected end of bit stream");
    }
    const bit = (this.data[this.byteIdx]! >> (7 - this.bitPos)) & 1;
    this.bitPos++;
    if (this.bitPos === 8) {
      this.bitPos = 0;
      this.byteIdx++;
    }
    return bit;
  }

  /** Reads `n` bits (0..32) as an unsigned number. */
  readBits(n: number): number {
    let result = 0;
    let remaining = n;
    while (remaining > 0) {
      if (this.byteIdx >= this.data.length) {
        throw new Error("unexpected end of bit stream");
      }
      const available = 8 - this.bitPos;
      const take = remaining < available ? remaining : available;
      const shift = available - take;
      const mask = (1 << take) - 1; // take <= 8
      result = (result << take) | ((this.data[this.byteIdx]! >> shift) & mask);
      remaining -= take;
      this.bitPos += take;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.byteIdx++;
      }
    }
    return result >>> 0;
  }

  /**
   * Golomb-Rice decode (no range checks). Safe as a number when the decoded
   * value fits in a JS safe integer (true for BIP-158 basic-filter deltas).
   */
  readGolombRice(p: number): number {
    let q = 0;
    for (;;) {
      if (this.byteIdx >= this.data.length) {
        throw new Error("unexpected end of bit stream");
      }
      const byte = this.data[this.byteIdx]!;
      for (let b = this.bitPos; b < 8; b++) {
        if (((byte >> (7 - b)) & 1) === 0) {
          this.bitPos = b + 1;
          if (this.bitPos === 8) {
            this.bitPos = 0;
            this.byteIdx++;
          }
          const rem = p === 0 ? 0 : this.readBits(p);
          return q * 2 ** p + rem;
        }
        q++;
      }
      this.byteIdx++;
      this.bitPos = 0;
    }
  }

  /** Golomb-Rice decode returning bigint (large filter ranges). */
  readGolombRiceBigInt(p: number): bigint {
    let q = 0n;
    for (;;) {
      if (this.readBit() === 0) break;
      q++;
    }
    if (p === 0) return q;
    return (q << BigInt(p)) | BigInt(this.readBits(p));
  }
}

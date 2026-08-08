/** Bitcoin CompactSize (a.k.a. varint) encode/decode. */

const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export function encodeCompactSize(n: number | bigint): Uint8Array {
  const value = normalizeCompactSizeValue(n);
  if (value <= 0xfcn) {
    return new Uint8Array([Number(value)]);
  }
  if (value <= 0xffffn) {
    return encodePrefixed(value, 0xfd, 2);
  }
  if (value <= 0xffff_ffffn) {
    return encodePrefixed(value, 0xfe, 4);
  }
  return encodePrefixed(value, 0xff, 8);
}

export type CompactSizeDecodeResult = { value: number; length: number };
export type CompactSizeBigIntDecodeResult = {
  value: bigint;
  length: number;
};

export function decodeCompactSize(
  bytes: Uint8Array,
  offset = 0,
): CompactSizeDecodeResult {
  const decoded = decodeCompactSizeBigInt(bytes, offset);
  if (decoded.value > MAX_SAFE_INTEGER_BIGINT) {
    throw new Error("CompactSize value exceeds safe integer range");
  }
  return { value: Number(decoded.value), length: decoded.length };
}

export function decodeCompactSizeBigInt(
  bytes: Uint8Array,
  offset = 0,
): CompactSizeBigIntDecodeResult {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(
      `CompactSize offset must be a non-negative integer, got ${offset}`,
    );
  }
  if (offset >= bytes.length) {
    throw new Error("unexpected end of data reading CompactSize");
  }
  const first = bytes[offset]!;
  if (first <= 0xfc) {
    return { value: BigInt(first), length: 1 };
  }
  if (first === 0xfd) {
    requireBytes(bytes, offset, 3);
    const value = readLittleEndian(bytes, offset + 1, 2);
    if (value <= 0xfcn) {
      throw new Error("non-canonical CompactSize encoding");
    }
    return { value, length: 3 };
  }
  if (first === 0xfe) {
    requireBytes(bytes, offset, 5);
    const value = readLittleEndian(bytes, offset + 1, 4);
    if (value <= 0xffffn) {
      throw new Error("non-canonical CompactSize encoding");
    }
    return { value, length: 5 };
  }
  requireBytes(bytes, offset, 9);
  const value = readLittleEndian(bytes, offset + 1, 8);
  if (value <= 0xffff_ffffn) {
    throw new Error("non-canonical CompactSize encoding");
  }
  return { value, length: 9 };
}

function normalizeCompactSizeValue(value: number | bigint): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `CompactSize number must be a safe integer, got ${value}`,
      );
    }
    if (value < 0) {
      throw new Error(
        `CompactSize value must be non-negative, got ${value}`,
      );
    }
    return BigInt(value);
  }
  if (typeof value !== "bigint") {
    throw new Error("CompactSize value must be a number or bigint");
  }
  if (value < 0n || value > UINT64_MAX) {
    throw new Error(`CompactSize value must be in uint64 range, got ${value}`);
  }
  return value;
}

function encodePrefixed(
  value: bigint,
  prefix: number,
  byteLength: number,
): Uint8Array {
  const out = new Uint8Array(byteLength + 1);
  out[0] = prefix;
  for (let i = 0; i < byteLength; i++) {
    out[i + 1] = Number((value >> BigInt(8 * i)) & 0xffn);
  }
  return out;
}

function readLittleEndian(
  bytes: Uint8Array,
  offset: number,
  byteLength: number,
): bigint {
  let value = 0n;
  for (let i = 0; i < byteLength; i++) {
    value |= BigInt(bytes[offset + i]!) << BigInt(8 * i);
  }
  return value;
}

function requireBytes(bytes: Uint8Array, offset: number, needed: number): void {
  if (offset + needed > bytes.length) {
    throw new Error("unexpected end of data reading CompactSize");
  }
}

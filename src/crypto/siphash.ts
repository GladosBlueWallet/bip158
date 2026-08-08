/**
 * SipHash-2-4 with uint32 limbs (adapted from jedisct1/siphash-js).
 * Compression uses mutable `{h,l}` slots — much faster than BigInt rounds.
 */

type U64 = { h: number; l: number };

const MASK64 = 0xffffffffffffffffn;

function add(a: U64, b: U64): void {
  const rl = a.l + b.l;
  a.h = (a.h + b.h + ((rl / 2) >>> 31)) >>> 0;
  a.l = rl >>> 0;
}

function xor(a: U64, b: U64): void {
  a.h = (a.h ^ b.h) >>> 0;
  a.l = (a.l ^ b.l) >>> 0;
}

function rotl(a: U64, n: number): void {
  const h = a.h;
  const l = a.l;
  a.h = (h << n) | (l >>> (32 - n));
  a.l = (l << n) | (h >>> (32 - n));
}

function rotl32(a: U64): void {
  const t = a.l;
  a.l = a.h;
  a.h = t;
}

function compress(v0: U64, v1: U64, v2: U64, v3: U64): void {
  add(v0, v1);
  add(v2, v3);
  rotl(v1, 13);
  rotl(v3, 16);
  xor(v1, v0);
  xor(v3, v2);
  rotl32(v0);
  add(v2, v1);
  add(v0, v3);
  rotl(v1, 17);
  rotl(v3, 21);
  xor(v1, v2);
  xor(v3, v0);
  rotl32(v2);
}

function getIntLE(a: Uint8Array, offset: number): number {
  return (
    a[offset]! |
    (a[offset + 1]! << 8) |
    (a[offset + 2]! << 16) |
    (a[offset + 3]! << 24)
  );
}

/** Precomputed SipHash initial state for a 16-byte key. */
export type SipHashKey = {
  v0: U64;
  v1: U64;
  v2: U64;
  v3: U64;
};

const _out: U64 = { h: 0, l: 0 };
const _mi: U64 = { h: 0, l: 0 };
const _ff: U64 = { h: 0, l: 0xff };
const _v0: U64 = { h: 0, l: 0 };
const _v1: U64 = { h: 0, l: 0 };
const _v2: U64 = { h: 0, l: 0 };
const _v3: U64 = { h: 0, l: 0 };
const _k0xor: U64 = { h: 0x736f6d65, l: 0x70736575 };
const _k1xor: U64 = { h: 0x646f7261, l: 0x6e646f6d };
const _k2xor: U64 = { h: 0x6c796765, l: 0x6e657261 };
const _k3xor: U64 = { h: 0x74656462, l: 0x79746573 };

function copyU64(dst: U64, src: U64): void {
  dst.h = src.h;
  dst.l = src.l;
}

function cloneU64(v: U64): U64 {
  return { h: v.h, l: v.l };
}

export function createSipHashKey(key: Uint8Array): SipHashKey {
  if (key.length !== 16) {
    throw new Error(`SipHash key must be 16 bytes, got ${key.length}`);
  }
  const k0: U64 = {
    l: getIntLE(key, 0) >>> 0,
    h: getIntLE(key, 4) >>> 0,
  };
  const k1: U64 = {
    l: getIntLE(key, 8) >>> 0,
    h: getIntLE(key, 12) >>> 0,
  };
  const v0 = cloneU64(k0);
  const v1 = cloneU64(k1);
  const v2 = cloneU64(k0);
  const v3 = cloneU64(k1);
  xor(v0, _k0xor);
  xor(v1, _k1xor);
  xor(v2, _k2xor);
  xor(v3, _k3xor);
  return { v0, v1, v2, v3 };
}

export type SipHashU64 = U64;

export function siphash24(key: Uint8Array, data: Uint8Array): bigint {
  const v = siphash24u64(key, data);
  return (BigInt(v.h >>> 0) << 32n) | BigInt(v.l >>> 0);
}

export function siphash24u64(key: Uint8Array, data: Uint8Array): U64 {
  const out: U64 = { h: 0, l: 0 };
  siphash24KeyedInto(createSipHashKey(key), data, out);
  return out;
}

function absorbBlock(mil: number, mih: number): void {
  _mi.l = mil;
  _mi.h = mih;
  xor(_v3, _mi);
  compress(_v0, _v1, _v2, _v3);
  compress(_v0, _v1, _v2, _v3);
  xor(_v0, _mi);
}

function finalize(mil: number, mih: number): void {
  _mi.l = mil;
  _mi.h = mih;
  xor(_v3, _mi);
  compress(_v0, _v1, _v2, _v3);
  compress(_v0, _v1, _v2, _v3);
  xor(_v0, _mi);
  xor(_v2, _ff);
  compress(_v0, _v1, _v2, _v3);
  compress(_v0, _v1, _v2, _v3);
  compress(_v0, _v1, _v2, _v3);
  compress(_v0, _v1, _v2, _v3);
}

export function siphash24KeyedInto(
  keyed: SipHashKey,
  data: Uint8Array,
  out: U64,
): void {
  copyU64(_v0, keyed.v0);
  copyU64(_v1, keyed.v1);
  copyU64(_v2, keyed.v2);
  copyU64(_v3, keyed.v3);

  const ml = data.length;

  // Specialized paths for common scriptPubKey sizes (wallet watchlists).
  if (ml === 22) {
    // P2WPKH: 2 full blocks + 6-byte tail (len=22 in top byte).
    absorbBlock(getIntLE(data, 0) >>> 0, getIntLE(data, 4) >>> 0);
    absorbBlock(getIntLE(data, 8) >>> 0, getIntLE(data, 12) >>> 0);
    finalize(
      (data[16]! | (data[17]! << 8) | (data[18]! << 16) | (data[19]! << 24)) >>>
        0,
      (data[20]! | (data[21]! << 8) | (22 << 24)) >>> 0,
    );
  } else if (ml === 25) {
    // P2PKH
    absorbBlock(getIntLE(data, 0) >>> 0, getIntLE(data, 4) >>> 0);
    absorbBlock(getIntLE(data, 8) >>> 0, getIntLE(data, 12) >>> 0);
    absorbBlock(getIntLE(data, 16) >>> 0, getIntLE(data, 20) >>> 0);
    finalize(data[24]! >>> 0, (25 << 24) >>> 0);
  } else if (ml === 34) {
    // P2TR / P2WSH
    absorbBlock(getIntLE(data, 0) >>> 0, getIntLE(data, 4) >>> 0);
    absorbBlock(getIntLE(data, 8) >>> 0, getIntLE(data, 12) >>> 0);
    absorbBlock(getIntLE(data, 16) >>> 0, getIntLE(data, 20) >>> 0);
    absorbBlock(getIntLE(data, 24) >>> 0, getIntLE(data, 28) >>> 0);
    finalize(
      (data[32]! | (data[33]! << 8)) >>> 0,
      (34 << 24) >>> 0,
    );
  } else {
    let mp = 0;
    const ml7 = ml - 7;
    while (mp < ml7) {
      absorbBlock(getIntLE(data, mp) >>> 0, getIntLE(data, mp + 4) >>> 0);
      mp += 8;
    }

    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    const b7 = ml & 0xff;
    const left = ml - mp;
    if (left > 0) b0 = data[mp]!;
    if (left > 1) b1 = data[mp + 1]!;
    if (left > 2) b2 = data[mp + 2]!;
    if (left > 3) b3 = data[mp + 3]!;
    if (left > 4) b4 = data[mp + 4]!;
    if (left > 5) b5 = data[mp + 5]!;
    if (left > 6) b6 = data[mp + 6]!;

    finalize(
      (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0,
      (b4 | (b5 << 8) | (b6 << 16) | (b7 << 24)) >>> 0,
    );
  }

  out.h = _v0.h;
  out.l = _v0.l;
  xor(out, _v1);
  xor(out, _v2);
  xor(out, _v3);
}

export function hashToRange(
  item: Uint8Array,
  F: bigint,
  key: Uint8Array,
): bigint {
  if (typeof F !== "bigint" || F < 1n || F > MASK64) {
    throw new Error(`F must be a bigint in 1..UINT64_MAX, got ${String(F)}`);
  }
  siphash24KeyedInto(createSipHashKey(key), item, _out);
  const vBig = (BigInt(_out.h >>> 0) << 32n) | BigInt(_out.l >>> 0);
  return (vBig * F) >> 64n;
}

export function hashToRangeNumberKeyed(
  item: Uint8Array,
  F: number,
  keyed: SipHashKey,
): number {
  if (!Number.isFinite(F) || F < 1 || F > Number.MAX_SAFE_INTEGER) {
    throw new Error(`F must be a safe integer >= 1, got ${F}`);
  }
  siphash24KeyedInto(keyed, item, _out);
  const vBig = (BigInt(_out.h >>> 0) << 32n) | BigInt(_out.l >>> 0);
  return Number((vBig * BigInt(F)) >> 64n);
}

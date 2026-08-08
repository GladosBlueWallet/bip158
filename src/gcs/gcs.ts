import { BitReader, BitWriter, FastBitReader } from "../crypto/bits.ts";
import { concatBytes, bytesToHex } from "../crypto/bytes.ts";
import {
  createSipHashKey,
  hashToRange,
  hashToRangeNumberKeyed,
} from "../crypto/siphash.ts";
import { decodeCompactSize, encodeCompactSize } from "../wire/compact-size.ts";

/** Default Golomb-Rice parameter for the BIP-158 wire format (basic filters). */
const DEFAULT_P = 19;
/** Default division constant `M` for the BIP-158 wire format (basic filters). */
const DEFAULT_M = 784931n;
const UINT32_MAX = 0xffff_ffff;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
const MAX_FILTER_DATA_BYTES = 4_000_000;
const MAX_FILTER_DATA_BITS = BigInt(MAX_FILTER_DATA_BYTES) * 8n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export type GcsFilter = {
  N: number;
  P: number;
  M: bigint;
  data: Uint8Array;
};

export type BuildGcsOptions = {
  items: Uint8Array[];
  key: Uint8Array;
  P: number;
  M: number | bigint;
};

export type DeserializeGcsOptions = {
  P?: number;
  M?: number | bigint;
};

function writeGolombRice(writer: BitWriter, value: bigint, p: number): void {
  const pBig = BigInt(p);
  let quotient = value >> pBig;
  const remainder = value & ((1n << pBig) - 1n);
  while (quotient > 0n) {
    writer.writeBit(1);
    quotient -= 1n;
  }
  writer.writeBit(0);
  writer.writeBits(remainder, p);
}

function readGolombRice(
  reader: BitReader,
  p: number,
  maxValue: bigint,
): bigint {
  const pBig = BigInt(p);
  const maxQuotient = maxValue >> pBig;
  let quotient = 0n;
  while (reader.readBit() === 1) {
    quotient += 1n;
    if (quotient > maxQuotient) {
      throw new Error("Golomb-Rice code is outside filter range");
    }
  }

  const base = quotient << pBig;
  const maxRemainder = maxValue - base;
  let remainder = 0n;
  for (let i = 0; i < p; i++) {
    remainder = (remainder << 1n) | BigInt(reader.readBit());
    const remainingBits = p - i - 1;
    if ((remainder << BigInt(remainingBits)) > maxRemainder) {
      throw new Error("Golomb-Rice code is outside filter range");
    }
  }
  return base | remainder;
}

function dedupeItems(items: Uint8Array[]): Uint8Array[] {
  const seen = new Set<string>();
  const out: Uint8Array[] = [];
  for (const item of items) {
    const hex = bytesToHex(item);
    if (!seen.has(hex)) {
      seen.add(hex);
      out.push(item);
    }
  }
  return out;
}

function compareBigint(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareNumber(a: number, b: number): number {
  return a - b;
}

type ValidatedFilterParameters = {
  N: number;
  P: number;
  M: bigint;
  F: bigint;
};

function validateP(P: number): number {
  if (typeof P !== "number" || !Number.isInteger(P) || P < 0 || P > 32) {
    throw new Error(`P must be an integer in 0..32, got ${String(P)}`);
  }
  return P;
}

function normalizeM(M: number | bigint): bigint {
  let normalized: bigint;
  if (typeof M === "number") {
    if (!Number.isSafeInteger(M)) {
      throw new Error(`numeric M must be a safe integer, got ${M}`);
    }
    normalized = BigInt(M);
  } else if (typeof M === "bigint") {
    normalized = M;
  } else {
    throw new Error("M must be an integer number or bigint");
  }
  if (normalized < 1n || normalized > BigInt(UINT32_MAX)) {
    throw new Error(`M must be an integer in 1..0xffffffff, got ${normalized}`);
  }
  return normalized;
}

function validateN(N: number): number {
  if (
    typeof N !== "number" ||
    !Number.isInteger(N) ||
    N < 0 ||
    N > UINT32_MAX
  ) {
    throw new Error(`N must be an integer in 0..0xffffffff, got ${String(N)}`);
  }
  return N;
}

function validateKey(key: Uint8Array): void {
  if (key.length !== 16) {
    throw new Error(`SipHash key must be 16 bytes, got ${key.length}`);
  }
}

function validateFilterParameters(filter: GcsFilter): ValidatedFilterParameters {
  const N = validateN(filter.N);
  const P = validateP(filter.P);
  const M = normalizeM(filter.M);
  const F = BigInt(N) * M;
  if (F > UINT64_MAX) {
    throw new Error(`filter range F exceeds UINT64_MAX: ${F}`);
  }
  return { N, P, M, F };
}

function validateFilterBody(
  data: Uint8Array,
  parameters: ValidatedFilterParameters,
  onValue?: (value: bigint) => void,
): void {
  if (!(data instanceof Uint8Array)) {
    throw new Error("GCS data must be a Uint8Array");
  }
  if (data.length > MAX_FILTER_DATA_BYTES) {
    throw new Error("GCS data exceeds the 4,000,000-byte limit");
  }

  const { N, P, F } = parameters;
  if (N === 0) {
    if (data.length !== 0) {
      throw new Error("empty GCS filter must not contain body data");
    }
    return;
  }

  const availableBits = BigInt(data.length) * 8n;
  const minimumBits = BigInt(N) * BigInt(P + 1);
  if (minimumBits > availableBits) {
    throw new Error(
      `truncated GCS body: ${N} values require at least ${minimumBits} bits`,
    );
  }

  const reader = new BitReader(data);
  let value = 0n;
  for (let i = 0; i < N; i++) {
    const maxDelta = F - value - 1n;
    value += readGolombRice(reader, P, maxDelta);
    if (value >= F) {
      throw new Error(`GCS value ${value} is outside filter range ${F}`);
    }
    onValue?.(value);
  }

  const expectedBytes = Math.ceil(reader.bitsRead / 8);
  if (data.length !== expectedBytes) {
    throw new Error("non-canonical GCS body contains excess bytes");
  }

  const usedBitsInLastByte = reader.bitsRead % 8;
  if (usedBitsInLastByte !== 0) {
    const paddingBits = 8 - usedBitsInLastByte;
    const paddingMask = (1 << paddingBits) - 1;
    if ((data[data.length - 1]! & paddingMask) !== 0) {
      throw new Error("non-canonical GCS body has nonzero padding");
    }
  }
}

function assertEncodedSize(values: bigint[], P: number): void {
  const pBig = BigInt(P);
  let bits = 0n;
  let last = 0n;
  for (const value of values) {
    const delta = value - last;
    bits += (delta >> pBig) + 1n + pBig;
    if (bits > MAX_FILTER_DATA_BITS) {
      throw new Error("GCS data exceeds the 4,000,000-byte limit");
    }
    last = value;
  }
}

/** Builds a Golomb-coded set filter (BIP-158 / btcd `BuildGCSFilter`). */
export function buildGcs(options: BuildGcsOptions): GcsFilter {
  const { key } = options;
  validateKey(key);
  const P = validateP(options.P);
  const M = normalizeM(options.M);
  const items = dedupeItems(options.items);
  const N = validateN(items.length);
  const F = BigInt(N) * M;
  if (F > UINT64_MAX) {
    throw new Error(`filter range F exceeds UINT64_MAX: ${F}`);
  }

  const hashed =
    N === 0
      ? []
      : items.map((item) => hashToRange(item, F, key)).sort(compareBigint);
  assertEncodedSize(hashed, P);

  const writer = new BitWriter();
  let last = 0n;
  for (const value of hashed) {
    const delta = value - last;
    writeGolombRice(writer, delta, P);
    last = value;
  }

  return { N, P, M, data: writer.finish() };
}

/** Serializes a filter as `CompactSize(N) || data`. Empty filters are a single `0x00` byte. */
export function serializeGcs(filter: GcsFilter): Uint8Array {
  const parameters = validateFilterParameters(filter);
  validateFilterBody(filter.data, parameters);
  return concatBytes(encodeCompactSize(parameters.N), filter.data);
}

/**
 * Lightweight parse of `CompactSize(N) || data` without body validation or copying.
 * Use {@link validateGcs} / {@link deserializeGcs} when ingesting untrusted bytes.
 */
export function parseGcs(
  bytes: Uint8Array,
  options?: DeserializeGcsOptions,
): GcsFilter {
  const { value: N, length } = decodeCompactSize(bytes, 0);
  const P = validateP(options?.P ?? DEFAULT_P);
  const M = normalizeM(options?.M ?? DEFAULT_M);
  validateN(N);
  const F = BigInt(N) * M;
  if (F > UINT64_MAX) {
    throw new Error(`filter range F exceeds UINT64_MAX: ${F}`);
  }
  if (bytes.length - length > MAX_FILTER_DATA_BYTES) {
    throw new Error("GCS data exceeds the 4,000,000-byte limit");
  }
  return { N, P, M, data: bytes.subarray(length) };
}

/** Deserializes and fully validates a canonical GCS filter body. */
export function deserializeGcs(
  bytes: Uint8Array,
  options?: DeserializeGcsOptions,
): GcsFilter {
  const { value: N, length } = decodeCompactSize(bytes, 0);
  const P = options?.P ?? DEFAULT_P;
  const M = normalizeM(options?.M ?? DEFAULT_M);
  if (bytes.length - length > MAX_FILTER_DATA_BYTES) {
    throw new Error("GCS data exceeds the 4,000,000-byte limit");
  }
  const data = Uint8Array.from(bytes.subarray(length));
  const filter = { N, P, M, data };
  const parameters = validateFilterParameters(filter);
  validateFilterBody(data, parameters);
  return filter;
}

/** Validates filter parameters and canonical body encoding. */
export function validateGcs(filter: GcsFilter): void {
  const parameters = validateFilterParameters(filter);
  validateFilterBody(filter.data, parameters);
}

/** Tests whether `item` is a member of the filter (fast path; no body re-validation). */
export function matchGcs(
  filter: GcsFilter,
  key: Uint8Array,
  item: Uint8Array,
): boolean {
  validateKey(key);
  const { N, P, F } = validateFilterParameters(filter);
  if (N === 0) return false;

  if (F <= MAX_SAFE) {
    const fNum = Number(F);
    const keyed = createSipHashKey(key);
    const target = hashToRangeNumberKeyed(item, fNum, keyed);
    const reader = new FastBitReader(filter.data);
    let value = 0;
    for (let i = 0; i < N; i++) {
      value += reader.readGolombRice(P);
      if (value === target) return true;
      if (value > target) return false;
    }
    return false;
  }

  const target = hashToRange(item, F, key);
  const reader = new FastBitReader(filter.data);
  let value = 0n;
  for (let i = 0; i < N; i++) {
    value += reader.readGolombRiceBigInt(P);
    if (value === target) return true;
    if (value > target) return false;
  }
  return false;
}

/**
 * Tests whether any of `items` is a member of the filter (fast path; no body
 * re-validation). Allocates a scratch buffer; prefer {@link matchAnyGcsFast}
 * when matching many filters against one watchlist.
 */
export function matchAnyGcs(
  filter: GcsFilter,
  key: Uint8Array,
  items: Uint8Array[],
): boolean {
  return matchAnyGcsFast(filter, key, items, new Array<number>(items.length));
}

function matchAnyGcsBigInt(
  data: Uint8Array,
  N: number,
  P: number,
  F: bigint,
  key: Uint8Array,
  items: Uint8Array[],
): boolean {
  const targets = new Array<bigint>(items.length);
  for (let i = 0; i < items.length; i++) {
    targets[i] = hashToRange(items[i]!, F, key);
  }
  targets.sort(compareBigint);

  const reader = new FastBitReader(data);
  let value = 0n;
  let ti = 0;
  const lastTarget = targets[targets.length - 1]!;
  for (let i = 0; i < N; i++) {
    value += reader.readGolombRiceBigInt(P);
    if (value > lastTarget) return false;
    while (ti < targets.length && targets[ti]! < value) {
      ti++;
    }
    if (ti === targets.length) return false;
    if (targets[ti] === value) return true;
  }
  return false;
}

function matchSortedNumberTargets(
  data: Uint8Array,
  N: number,
  P: number,
  targets: number[],
  targetCount: number,
): boolean {
  if (targetCount === 0) return false;
  // Insertion sort / native sort of a copy for the prefix would allocate.
  // Callers that use batch API pre-sort via sortPrefix.
  const reader = new FastBitReader(data);
  let value = 0;
  let ti = 0;
  const lastTarget = targets[targetCount - 1]!;
  for (let i = 0; i < N; i++) {
    value += reader.readGolombRice(P);
    if (value > lastTarget) return false;
    while (ti < targetCount && targets[ti]! < value) {
      ti++;
    }
    if (ti === targetCount) return false;
    if (targets[ti] === value) return true;
  }
  return false;
}

/** Sorts `arr[0..len)` in place (numeric ascending). */
function sortNumberPrefix(arr: number[], len: number): void {
  if (len < 2) return;
  if (len === arr.length) {
    arr.sort(compareNumber);
    return;
  }
  // Timsort the prefix via a typed view would still copy; use quicksort-ish.
  quickSort(arr, 0, len - 1);
}

function quickSort(arr: number[], left: number, right: number): void {
  while (left < right) {
    const pivot = arr[(left + right) >> 1]!;
    let i = left;
    let j = right;
    while (i <= j) {
      while (arr[i]! < pivot) i++;
      while (arr[j]! > pivot) j--;
      if (i <= j) {
        const tmp = arr[i]!;
        arr[i] = arr[j]!;
        arr[j] = tmp;
        i++;
        j--;
      }
    }
    if (j - left < right - i) {
      if (left < j) quickSort(arr, left, j);
      left = i;
    } else {
      if (i < right) quickSort(arr, i, right);
      right = j;
    }
  }
}

/**
 * Hot-path MatchAny for filters whose `F` fits in a safe integer.
 * Mutates `targetsScratch[0..items.length)` as hashed+sorted targets.
 */
export function matchAnyGcsFast(
  filter: GcsFilter,
  key: Uint8Array,
  items: Uint8Array[],
  targetsScratch: number[],
): boolean {
  validateKey(key);
  if (items.length === 0) return false;
  const { N, P, F } = validateFilterParameters(filter);
  if (N === 0) return false;
  if (F > MAX_SAFE) {
    return matchAnyGcsBigInt(filter.data, N, P, F, key, items);
  }

  const Fnum = Number(F);
  const len = items.length;
  const keyed = createSipHashKey(key);
  for (let i = 0; i < len; i++) {
    targetsScratch[i] = hashToRangeNumberKeyed(items[i]!, Fnum, keyed);
  }
  sortNumberPrefix(targetsScratch, len);
  return matchSortedNumberTargets(filter.data, N, P, targetsScratch, len);
}

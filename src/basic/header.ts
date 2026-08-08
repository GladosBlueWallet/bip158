import { sha256d } from "../crypto/hash.ts";
import { concatBytes } from "../crypto/bytes.ts";

/** Hash of a serialized filter: `SHA256d(filterBytes)` (BIP-158 "Filter Hash"). */
export function filterHash(filterBytes: Uint8Array): Uint8Array {
  return sha256d(filterBytes);
}

/**
 * Chains a filter hash onto the previous filter header (BIP-158 "Filter Header"):
 * `SHA256d(filterHash || prevHeader)`.
 *
 * Both arguments and the return value are in **internal** (little-endian) byte
 * order. RPC / vector filter headers are display-order; convert with
 * `displayHashToInternal()` before calling and when comparing results.
 */
export function filterHeader(
  filterHashBytes: Uint8Array,
  prevHeader: Uint8Array,
): Uint8Array {
  if (filterHashBytes.length !== 32) {
    throw new Error(
      `filter hash must be 32 bytes, got ${filterHashBytes.length}`,
    );
  }
  if (prevHeader.length !== 32) {
    throw new Error(
      `previous header must be 32 bytes, got ${prevHeader.length}`,
    );
  }
  return sha256d(concatBytes(filterHashBytes, prevHeader));
}

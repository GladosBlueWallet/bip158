import {
  buildGcs,
  matchAnyGcsFast,
  parseGcs,
  serializeGcs,
} from "../gcs/gcs.ts";
import { BASIC_FILTER_M, BASIC_FILTER_P } from "./params.ts";

/**
 * Reverses a display-order (RPC/big-endian hex) block hash into Bitcoin's
 * internal little-endian byte representation.
 */
export function displayHashToInternal(display: Uint8Array): Uint8Array {
  if (display.length !== 32) {
    throw new Error(
      `display hash must be 32 bytes, got ${display.length}`,
    );
  }
  const out = new Uint8Array(display.length);
  for (let i = 0; i < display.length; i++) {
    out[i] = display[display.length - 1 - i]!;
  }
  return out;
}

/**
 * Derives the SipHash key for a basic filter: the first 16 bytes of the
 * block hash in internal little-endian representation (BIP-158).
 */
function basicFilterKey(blockHashInternal: Uint8Array): Uint8Array {
  if (blockHashInternal.length !== 32) {
    throw new Error(
      `block hash must be 32 bytes, got ${blockHashInternal.length}`,
    );
  }
  return Uint8Array.from(blockHashInternal.subarray(0, 16));
}

/**
 * Derives the SipHash key from a display-order (RPC/big-endian hex) block
 * hash, as supplied by explorers and the official BIP-158 test vectors.
 */
function basicFilterKeyFromDisplay(displayBlockHash: Uint8Array): Uint8Array {
  return basicFilterKey(displayHashToInternal(displayBlockHash));
}

export type BuildBasicFilterOptions = {
  blockHashDisplay: Uint8Array;
  elements: Uint8Array[];
};

/** Builds a serialized basic (type 0) BIP-158 filter for a block. */
export function buildBasicFilter(options: BuildBasicFilterOptions): Uint8Array {
  const key = basicFilterKeyFromDisplay(options.blockHashDisplay);
  const filter = buildGcs({
    items: options.elements.filter((element) => element.length !== 0),
    key,
    P: BASIC_FILTER_P,
    M: BASIC_FILTER_M,
  });
  return serializeGcs(filter);
}

/**
 * Match one watchlist against many basic filters (wallet sync hot path).
 * Returns a boolean per filter. Reuses one target scratch buffer across filters.
 * Pass a single filter/hash for one-filter matching.
 *
 * Filters are matched without canonical body re-validation — validate on ingest
 * with {@link deserializeGcs} / `validateGcs`.
 */
export function matchAnyBasicFilters(
  filterBytesList: Uint8Array[],
  blockHashDisplayList: Uint8Array[],
  items: Uint8Array[],
): boolean[] {
  if (filterBytesList.length !== blockHashDisplayList.length) {
    throw new Error(
      `filter/hash length mismatch: ${filterBytesList.length} filters, ${blockHashDisplayList.length} hashes`,
    );
  }
  const out = new Array<boolean>(filterBytesList.length);
  if (items.length === 0) {
    out.fill(false);
    return out;
  }

  const scratch = new Array<number>(items.length);
  const internalHash = new Uint8Array(32);

  for (let i = 0; i < filterBytesList.length; i++) {
    const display = blockHashDisplayList[i]!;
    if (display.length !== 32) {
      throw new Error(`display hash must be 32 bytes, got ${display.length}`);
    }
    for (let j = 0; j < 32; j++) {
      internalHash[j] = display[31 - j]!;
    }
    const key = internalHash.subarray(0, 16);
    const filter = parseGcs(filterBytesList[i]!, {
      P: BASIC_FILTER_P,
      M: BASIC_FILTER_M,
    });
    out[i] = matchAnyGcsFast(filter, key, items, scratch);
  }
  return out;
}

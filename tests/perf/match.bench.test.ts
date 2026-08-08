/**
 * Wallet-shaped matching benchmark: ~200 scripts × many filters.
 * Run with: bun test ./tests/perf/match.bench.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  buildBasicFilter,
  matchAnyBasicFilters,
} from "../../src/basic/filter.ts";

function scriptPubKey(namespace: number, i: number): Uint8Array {
  // Unique 20-byte payload: namespace || i as big-endian fields (no modular wrap collisions).
  const out = new Uint8Array(22);
  out[0] = 0x00;
  out[1] = 0x14;
  out[2] = (namespace >>> 24) & 0xff;
  out[3] = (namespace >>> 16) & 0xff;
  out[4] = (namespace >>> 8) & 0xff;
  out[5] = namespace & 0xff;
  out[6] = (i >>> 24) & 0xff;
  out[7] = (i >>> 16) & 0xff;
  out[8] = (i >>> 8) & 0xff;
  out[9] = i & 0xff;
  for (let j = 10; j < 22; j++) {
    out[j] = (namespace + i + j) & 0xff;
  }
  return out;
}

function blockHashDisplay(i: number): Uint8Array {
  const out = new Uint8Array(32);
  for (let j = 0; j < 32; j++) {
    out[j] = (i * 13 + j * 7) & 0xff;
  }
  out[0] = 0;
  out[1] = 0;
  return out;
}

const WATCHLIST_SIZE = 200;
/** Typical BIP-157 `cfilter` response size from a Bitcoin peer. */
const FILTER_COUNT = 1000;
const ELEMENTS_PER_FILTER = 800;
const WATCH_NS = 0x1111_1111;
const FILTER_NS = 0x2222_2222;

describe("match performance (wallet-shaped)", () => {
  test(
    "matchAnyBasicFilters over a peer-sized filter batch",
    () => {
      const watchlist = Array.from({ length: WATCHLIST_SIZE }, (_, i) =>
        scriptPubKey(WATCH_NS, i),
      );

      const filterBytes: Uint8Array[] = [];
      const hashes: Uint8Array[] = [];
      let plantedHits = 0;
      for (let f = 0; f < FILTER_COUNT; f++) {
        const hash = blockHashDisplay(f);
        const elements = Array.from({ length: ELEMENTS_PER_FILTER }, (_, i) =>
          scriptPubKey(FILTER_NS, f * ELEMENTS_PER_FILTER + i),
        );
        if (f % 20 === 0) {
          elements[elements.length >> 1] = watchlist[f % watchlist.length]!;
          plantedHits++;
        }
        filterBytes.push(
          buildBasicFilter({ blockHashDisplay: hash, elements }),
        );
        hashes.push(hash);
      }

      for (let i = 0; i < 3; i++) {
        matchAnyBasicFilters(
          [filterBytes[0]!],
          [hashes[0]!],
          watchlist,
        );
      }

      const t0 = performance.now();
      const batchHits = matchAnyBasicFilters(filterBytes, hashes, watchlist);
      const ms = performance.now() - t0;
      const hits = batchHits.reduce((a, b) => a + (b ? 1 : 0), 0);

      console.log(
        `[perf] matchAnyBasicFilters: ${FILTER_COUNT} filters × ${WATCHLIST_SIZE} scripts, ` +
          `${ELEMENTS_PER_FILTER} elems/filter → ${ms.toFixed(1)}ms total, ` +
          `${(ms / FILTER_COUNT).toFixed(3)}ms/filter, hits=${hits} (planted=${plantedHits})`,
      );

      expect(hits).toBe(plantedHits);
      // Soft regression gate for match time only (filter build dominates wall clock).
      // Pre-rewrite baseline was ~3ms/filter → ~3s for 1000 filters.
      expect(ms).toBeLessThan(2_000);
    },
    { timeout: 60_000 },
  );
});

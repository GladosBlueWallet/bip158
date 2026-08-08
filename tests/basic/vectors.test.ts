import { describe, expect, test } from "bun:test";
import { loadTestnet19 } from "../helpers/vectors.ts";
import {
  basicFilterElements,
  buildBasicFilter,
  bytesToHex,
  displayHashToInternal,
  filterHash,
  filterHeader,
  hexToBytes,
} from "../../src/index.ts";

describe("official testnet-19 vectors", () => {
  const rows = loadTestnet19();
  test("loads 10 vector rows", () => {
    expect(rows).toHaveLength(10);
  });

  for (const row of rows) {
    test(`height ${row.height}: ${row.notes || "filter+header"}`, () => {
      const blockHash = hexToBytes(row.blockHashHex); // display order from vector
      const prevScripts = row.prevScriptsHex.map(hexToBytes);
      const elements = basicFilterElements({
        blockBytes: hexToBytes(row.blockHex),
        prevOutputScripts: prevScripts,
      });
      const filterBytes = buildBasicFilter({
        blockHashDisplay: blockHash,
        elements,
      });
      expect(bytesToHex(filterBytes)).toBe(row.basicFilterHex);
      const prevHeader = displayHashToInternal(
        hexToBytes(row.prevBasicHeaderHex),
      );
      const header = filterHeader(filterHash(filterBytes), prevHeader);
      expect(bytesToHex(displayHashToInternal(header))).toBe(
        row.basicHeaderHex,
      );
    });
  }
});

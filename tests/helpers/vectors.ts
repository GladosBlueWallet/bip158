import { readFileSync } from "node:fs";
import { join } from "node:path";

export type VectorRow = {
  height: number;
  blockHashHex: string;
  blockHex: string;
  prevScriptsHex: string[];
  prevBasicHeaderHex: string;
  basicFilterHex: string;
  basicHeaderHex: string;
  notes: string;
};

export function loadTestnet19(): VectorRow[] {
  const path = join(import.meta.dir, "../../testdata/bip158/testnet-19.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown[];
  // row 0 is a header description string array — skip it
  return raw.slice(1).map((row) => {
    const r = row as [
      number,
      string,
      string,
      string[],
      string,
      string,
      string,
      string,
    ];
    return {
      height: r[0],
      blockHashHex: r[1],
      blockHex: r[2],
      prevScriptsHex: r[3],
      prevBasicHeaderHex: r[4],
      basicFilterHex: r[5],
      basicHeaderHex: r[6],
      notes: r[7] ?? "",
    };
  });
}

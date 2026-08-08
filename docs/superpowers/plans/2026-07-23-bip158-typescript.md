# BIP-158 TypeScript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an isomorphic TypeScript BIP-158 library (GCS + basic filters + headers + element extraction) validated against official `testnet-19.json` vectors.

**Architecture:** Pure `Uint8Array` modules under `src/crypto`, `src/gcs`, `src/basic`, `src/wire`. SipHash-2-4 and Golomb-Rice implemented in TypeScript; SHA-256 via `@noble/hashes`. Algorithms borrowed from btcd `btcutil/gcs` and BIP `gentestvectors.go`. No BIP-157 / networking.

**Tech Stack:** TypeScript ESM, Bun test runner, `@noble/hashes` (SHA-256 only — SipHash is custom; `@noble/hashes` has no SipHash export).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-23-bip158-typescript-design.md`
- No `node:` / `bun:` imports under `src/`
- Public API uses `Uint8Array` only (no Node `Buffer`)
- Official vectors: `testdata/bip158/testnet-19.json` from `bitcoin/bips`
- Basic filter: `P = 19`, `M = 784931`
- Empty filter serializes as a single zero byte
- Key = first 16 bytes of block hash in **internal (LE)** order
- TDD: failing tests before implementation; commit after each task
- No hard dependency on `bip324`

## File map

| Path | Responsibility |
|------|----------------|
| `package.json` / `tsconfig.json` | Package scripts, Bun types |
| `testdata/bip158/testnet-19.json` | Official vectors |
| `testdata/bip158/README.md` | Provenance |
| `src/crypto/bytes.ts` | hex / concat / equal |
| `src/crypto/bits.ts` | BitReader / BitWriter |
| `src/crypto/siphash.ts` | SipHash-2-4 + `hashToRange` |
| `src/crypto/hash.ts` | SHA-256 / Hash256 |
| `src/gcs/gcs.ts` | GCS build / serialize / match / matchAny |
| `src/basic/params.ts` | `BASIC_FILTER_P`, `BASIC_FILTER_M` |
| `src/basic/filter.ts` | key, build/match basic filter bytes |
| `src/basic/header.ts` | filterHash / filterHeader |
| `src/basic/elements.ts` | Extract elements from block + prev scripts |
| `src/wire/block.ts` | Minimal block/tx decoder for element extraction |
| `src/index.ts` | Exports |
| `tests/**` | Unit + vector tests |
| `README.md` | Usage |

---

### Task 1: Scaffold + vendor official vectors + failing vector harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `testdata/bip158/testnet-19.json`, `testdata/bip158/README.md`, `tests/helpers/vectors.ts`, `tests/basic/vectors.test.ts`, `README.md` (stub)

**Interfaces:**
- Produces: `loadTestnet19(): VectorRow[]` where each row has `height`, `blockHashHex`, `blockHex`, `prevScriptsHex[]`, `prevBasicHeaderHex`, `basicFilterHex`, `basicHeaderHex`, `notes`

- [ ] **Step 1: Create package scaffold**

`package.json`:
```json
{
  "name": "bip158",
  "version": "0.0.1",
  "description": "Isomorphic BIP-158 compact block filters (GCS) for TypeScript",
  "type": "module",
  "sideEffects": false,
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "check": "bun run typecheck && bun test"
  },
  "dependencies": {
    "@noble/hashes": "^2.2.0"
  },
  "devDependencies": {
    "@types/bun": "^1.3.14",
    "typescript": "^5.9.3"
  }
}
```

`tsconfig.json` (strict ESM, `types: ["bun"]`, include `src` + `tests`).

- [ ] **Step 2: Download official vectors**

```bash
mkdir -p testdata/bip158
curl -fsSL -o testdata/bip158/testnet-19.json \
  https://raw.githubusercontent.com/bitcoin/bips/master/bip-0158/testnet-19.json
```

`testdata/bip158/README.md`:
```markdown
# BIP-158 test vectors

Source: https://github.com/bitcoin/bips/tree/master/bip-0158

- `testnet-19.json` — basic filter + header vectors for selected testnet blocks
```

- [ ] **Step 3: Write vector loader + failing end-to-end test**

```ts
// tests/helpers/vectors.ts
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
```

```ts
// tests/basic/vectors.test.ts
import { describe, expect, test } from "bun:test";
import { loadTestnet19 } from "../helpers/vectors.ts";
import {
  basicFilterElements,
  buildBasicFilter,
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
      const filterBytes = buildBasicFilter({ blockHash, elements });
      expect(Buffer.from(filterBytes).toString("hex")).toBe(row.basicFilterHex);
      // Prefer bytesToHex from our helpers once available — use that, not Buffer.
      const header = filterHeader(filterHash(filterBytes), hexToBytes(row.prevBasicHeaderHex));
      expect(/* bytesToHex(header) */ header).toEqual(hexToBytes(row.basicHeaderHex));
    });
  }
});
```

**Important:** In the real test file use `bytesToHex` (not Node `Buffer`) for hex comparisons. Vector `blockHashHex` is **display (RPC) order**; `basicFilterKey` must reverse to internal LE before taking 16 bytes — document this in `basicFilterKey` JSDoc and tests.

- [ ] **Step 4: Run tests — expect FAIL**

Run: `bun install && bun test tests/basic/vectors.test.ts`  
Expected: FAIL (module `src/index.ts` missing)

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json testdata tests README.md bun.lock
git commit -m "$(cat <<'EOF'
chore: scaffold bip158 with official test vectors

EOF
)"
```

---

### Task 2: Byte + bit stream primitives

**Files:**
- Create: `src/crypto/bytes.ts`, `src/crypto/bits.ts`, `tests/crypto/bytes.test.ts`, `tests/crypto/bits.test.ts`

**Interfaces:**
- Produces:
  - `hexToBytes(hex: string): Uint8Array`
  - `bytesToHex(bytes: Uint8Array): string`
  - `concatBytes(...parts: Uint8Array[]): Uint8Array`
  - `equalBytes(a: Uint8Array, b: Uint8Array): boolean`
  - `class BitWriter { writeBit(b: 0|1); writeBits(value: bigint, n: number); finish(): Uint8Array }`
  - `class BitReader { constructor(data: Uint8Array); readBit(): 0|1; readBits(n: number): bigint; }`

Borrow bit packing order from bcoin/btcd: MSB-first within each byte (write high bit first). BIP-158 `write_bits_big_endian` for the P-bit remainder.

- [ ] **Step 1: Failing tests for hex + Golomb-Rice bit round-trip**

```ts
// tests/crypto/bits.test.ts
import { describe, expect, test } from "bun:test";
import { BitReader, BitWriter } from "../../src/crypto/bits.ts";

describe("BitWriter/BitReader", () => {
  test("round-trips unary-ish pattern and P-bit remainder", () => {
    const w = new BitWriter();
    // encode value 5 with P=2 → q=1,r=1 → bits 1 0 01
    w.writeBit(1);
    w.writeBit(0);
    w.writeBits(1n, 2);
    const bytes = w.finish();
    const r = new BitReader(bytes);
    expect(r.readBit()).toBe(1);
    expect(r.readBit()).toBe(0);
    expect(r.readBits(2)).toBe(1n);
  });
});
```

Also test `hexToBytes` rejects non-hex; `bytesToHex` lowercases.

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test tests/crypto/bytes.test.ts tests/crypto/bits.test.ts`

- [ ] **Step 3: Implement `bytes.ts` and `bits.ts`**

Implement MSB-first bit streams matching btcd/bcoin behavior (verify against a known encoded filter later in Task 4).

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: add byte and bit-stream primitives

EOF
)"
```

---

### Task 3: SipHash-2-4 + hashToRange

**Files:**
- Create: `src/crypto/siphash.ts`, `tests/crypto/siphash.test.ts`

**Interfaces:**
- Produces:
  - `siphash24(key: Uint8Array /*16*/, data: Uint8Array): bigint` — 64-bit result as unsigned bigint
  - `hashToRange(item: Uint8Array, F: bigint, key: Uint8Array): bigint` — `(siphash * F) >> 64` with full 128-bit intermediate

Borrow SipHash-2-4 from a known reference (e.g. Rust `siphasher` / Go `hash/fnv` is wrong — use btcd/`bsip`/standard SipHash-2-4 test vectors). Include classic SipHash paper vectors if useful, plus a cross-check that genesis basic filter construction hashes match once GCS lands.

`hashToRange` MUST use 128-bit multiplication: in JS, implement via 32-bit limbs or `BigInt` then mask:

```ts
export function hashToRange(item: Uint8Array, F: bigint, key: Uint8Array): bigint {
  const v = siphash24(key, item); // 0..2^64-1
  return (v * F) >> 64n;
}
```

- [ ] **Step 1: Failing SipHash / hashToRange tests**

Use well-known SipHash-2-4 test vector (key `00..0f`, message `00..0e` → `a129ca6149be45e5` from the SipHash paper) plus a small `hashToRange` sanity check.

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement SipHash-2-4** (pure TS, little-endian key/message loading)

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: add SipHash-2-4 and hashToRange

EOF
)"
```

---

### Task 4: Generic GCS construct / serialize / match

**Files:**
- Create: `src/gcs/gcs.ts`, `tests/gcs/gcs.test.ts`
- Modify: `src/index.ts` (export GCS API)

**Interfaces:**
- Produces:
```ts
export type GcsFilter = { N: number; P: number; M: bigint; data: Uint8Array };

buildGcs(options: { items: Uint8Array[]; key: Uint8Array; P: number; M: number | bigint }): GcsFilter
serializeGcs(filter: GcsFilter): Uint8Array  // CompactSize(N) || data; N=0 → 0x00
deserializeGcs(bytes: Uint8Array, options?: { P?: number; M?: number | bigint }): GcsFilter
matchGcs(filter: GcsFilter, key: Uint8Array, item: Uint8Array): boolean
matchAnyGcs(filter: GcsFilter, key: Uint8Array, items: Uint8Array[]): boolean
```

Algorithm (from BIP-158 / btcd):
1. Deduplicate items (byte equality)
2. `F = N * M` (bigint)
3. Map each item with `hashToRange`, sort ascending
4. Encode deltas with Golomb-Rice (`P`)
5. Match: decode deltas until value ≥ target

CompactSize: implement minimal encoder/decoder in `gcs.ts` or `src/wire/compact-size.ts` (0–252 single byte; support up to 32-bit N as BIP requires `N < 2^32`).

- [ ] **Step 1: Failing unit tests** — build from items, serialize round-trip, match positives, reject absent item, empty filter `0x00`

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement GCS** (borrow control flow from btcd `BuildGCSFilter` / `Match` / `MatchAny`)

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: implement Golomb-coded set build and match

EOF
)"
```

---

### Task 5: Basic filter key + build/match + filter headers

**Files:**
- Create: `src/crypto/hash.ts`, `src/basic/params.ts`, `src/basic/filter.ts`, `src/basic/header.ts`, `tests/basic/filter.test.ts`, `tests/basic/header.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
```ts
export const BASIC_FILTER_P = 19;
export const BASIC_FILTER_M = 784931n; // or number 784931 used as bigint inside

basicFilterKey(blockHash: Uint8Array): Uint8Array
// blockHash may be display-order 32 bytes from explorers/vectors — document:
// vectors supply display hex; convert with displayHashToInternal then first 16 bytes,
// OR accept internal LE and document call sites. Prefer:
displayHashToInternal(display: Uint8Array): Uint8Array
basicFilterKeyFromDisplay(displayBlockHash: Uint8Array): Uint8Array

buildBasicFilter(options: { blockHashDisplay: Uint8Array; elements: Uint8Array[] }): Uint8Array
matchBasicFilter(filterBytes: Uint8Array, blockHashDisplay: Uint8Array, item: Uint8Array): boolean
matchAnyBasicFilter(...): boolean

filterHash(filterBytes: Uint8Array): Uint8Array  // SHA256d
filterHeader(filterHashBytes: Uint8Array, prevHeader: Uint8Array): Uint8Array
// header = SHA256d( filterHash || prevHeader )  — verify against btcd/BIP vectors
```

**Hash endianness note (critical):** BIP-158: key is first 16 bytes of the block hash in **standard little-endian representation**. Vector column “Block Hash” is RPC/display (big-endian hex). Implementation must reverse display→internal before slicing 16 bytes. Filter header chaining must match vector `Previous Basic Header` → `Basic Header`.

Confirm `filterHash` / `filterHeader` concatenation order against btcd `builder` / BIP vectors in Task 5 tests using genesis row constants without needing full element extraction yet: hardcode genesis elements from known scripts if needed, OR push full vector assert to Task 6/7.

Minimum for this task:
- Unit test genesis filter hex `019dfca8` by building from the known genesis output script element(s) listed in BIP / prior art
- Unit test genesis header from `prev=0x00..00` → `21584579…`

Genesis basic filter elements: genesis coinbase has no prev scripts; one output script (the famous pubkey script). Filter `019dfca8`.

- [ ] **Step 1: Failing genesis filter + header tests**

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement hash + basic filter + header helpers**

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: add basic filter build/match and filter headers

EOF
)"
```

---

### Task 6: Minimal block wire decoder + basicFilterElements

**Files:**
- Create: `src/wire/compact-size.ts` (if not already), `src/wire/block.ts`, `src/basic/elements.ts`, `tests/basic/elements.test.ts`, `tests/wire/block.test.ts`
- Modify: `src/index.ts`, `tests/basic/vectors.test.ts` (enable full rows)

**Interfaces:**
```ts
export type BasicFilterBlockInput = {
  blockBytes: Uint8Array;
  /** Previous output scripts for all non-coinbase inputs, in block order */
  prevOutputScripts: Uint8Array[];
};

basicFilterElements(input: BasicFilterBlockInput): Uint8Array[]
decodeBlockTransactions(blockBytes: Uint8Array): DecodedTx[]
```

Rules:
- Skip coinbase inputs (no prev scripts consumed)
- For each non-coinbase input, take next script from `prevOutputScripts` (must match count)
- For each output: include `scriptPubKey` unless length≥1 and `scriptPubKey[0] === 0x6a`
- Omit empty scripts
- Support segwit txs (vector height 1263442)

Borrow tx parsing structure from Bitcoin Core wire / `bip324` `PayloadReader` patterns — reimplement locally (no bip324 import).

- [ ] **Step 1: Failing tests** — genesis elements length 1; OP_RETURN exclusion unit test; witness block parses

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement decoder + `basicFilterElements`**

- [ ] **Step 4: Run element tests — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: extract BIP-158 basic filter elements from blocks

EOF
)"
```

---

### Task 7: Make all official vectors green + polish README

**Files:**
- Modify: `tests/basic/vectors.test.ts`, `src/index.ts`, `README.md`
- Optionally: `package.json` `files` field

**Interfaces:** Consumes all prior APIs. Produces green `bun run check`.

- [ ] **Step 1: Ensure vector test asserts every row**

For each of 10 rows:
1. `elements = basicFilterElements({ blockBytes, prevOutputScripts })`
2. `filterBytes = buildBasicFilter({ blockHashDisplay, elements })`
3. `bytesToHex(filterBytes) === basicFilterHex`
4. `filterHeader(filterHash(filterBytes), prevHeader) === basicHeader`

- [ ] **Step 2: Run full suite**

Run: `bun run check`  
Expected: all vector rows PASS; typecheck PASS

If a row fails, compare element sets / endianness / CompactSize before changing GCS math. Special cases called out in vector notes (empty scripts, OP_RETURN, witness, duplicate pushdata).

- [ ] **Step 3: Write README**

Document install, `buildBasicFilter` / `matchBasicFilter` example, vector provenance, non-goals (no BIP-157).

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: pass official BIP-158 testnet filter vectors

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Vendor official vectors + TDD harness | 1 |
| Isomorphic bytes / bit I/O | 2 |
| SipHash-2-4 + hashToRange | 3 |
| GCS build/serialize/match/matchAny | 4 |
| Basic P/M, key, build/match | 5 |
| Filter hash / header | 5 |
| basicFilterElements + block decode | 6 |
| All testnet-19 rows green | 7 |
| README | 7 |
| No BIP-157 | all |

## Self-review notes

- `@noble/hashes` provides SHA-256; SipHash is first-party (noble has no SipHash export as of 2.2).
- Display vs internal block-hash endianness is the sharp edge for vector compliance — call it out in API docs.
- Block decoder is the riskiest Task 6 piece (segwit); keep it minimal and vector-driven.

---

## Execution handoff

After saving this plan, offer:

**1. Subagent-Driven (recommended)** — fresh subagent per task  
**2. Inline Execution** — execute in this session with checkpoints

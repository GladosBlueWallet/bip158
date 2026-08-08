# BIP-158 TypeScript Design

Status: Draft  
Date: 2026-07-23

## Goal

Ship an isomorphic TypeScript **BIP-158** library: Golomb-coded sets, basic compact block filters, filter hash/header chaining, and basic-filter element extraction from blocks — validated against official BIP test vectors.

Patterned after `bip324`: runtime-neutral core, modular layout, TDD with official vectors first, borrow algorithms from reference implementations.

## Non-goals

- BIP-157 P2P messages / Neutrino sync engine
- Socket I/O or peer management
- Full-node filter indexing service
- Hard dependency on the `bip324` package (keep independent; shapes may align for later composition)

## Approach

**`@noble/hashes` + pure TypeScript bit I/O** for SipHash-2-4, SHA-256, Golomb-Rice, and range reduction. No WASM, no Node `Buffer` in the public API.

Borrow from:
- BIP-158 specification and `bip-0158/testnet-19.json` + `gentestvectors.go`
- btcd `btcutil/gcs` / bcoin `golomb` algorithms (not as runtime deps)

## Architecture

```text
src/
  crypto/     siphash, bits, bytes, hash (sha256)
  gcs/        generic GCS construct / serialize / match
  basic/      Basic filter params, key, elements, header
  index.ts    exports
testdata/bip158/
  testnet-19.json
  README.md
tests/
```

| Module | Responsibility |
|--------|----------------|
| `crypto/siphash.ts` | SipHash-2-4; `hashToRange(item, F, key)` |
| `crypto/bits.ts` | Bit reader/writer for Golomb-Rice |
| `crypto/bytes.ts` | `Uint8Array` hex/concat helpers |
| `crypto/hash.ts` | SHA-256 / double-SHA-256 for filter hash |
| `gcs/gcs.ts` | Construct, serialize (`CompactSize N ‖ data`), match, matchAny |
| `basic/filter.ts` | `P=19`, `M=784931`; key from block hash; build/match helpers |
| `basic/elements.ts` | Extract basic-filter elements from a typed block |
| `basic/header.ts` | `filterHash`, `filterHeader(prev)` |

## Public API (v0)

```ts
// GCS
buildGcs(options: { items: Uint8Array[]; key: Uint8Array; P: number; M: number }): GcsFilter
serializeGcs(filter: GcsFilter): Uint8Array
deserializeGcs(bytes: Uint8Array, P?: number): GcsFilter  // default P=19 for BIP-158 wire
matchGcs(filter: GcsFilter, key: Uint8Array, item: Uint8Array): boolean
matchAnyGcs(filter: GcsFilter, key: Uint8Array, items: Uint8Array[]): boolean

// Basic filter
BASIC_FILTER_P = 19
BASIC_FILTER_M = 784931
basicFilterKey(blockHash: Uint8Array): Uint8Array  // first 16 bytes of LE hash
buildBasicFilter(options: { blockHash: Uint8Array; elements: Uint8Array[] }): Uint8Array
matchBasicFilter(filterBytes: Uint8Array, blockHash: Uint8Array, item: Uint8Array): boolean
matchAnyBasicFilter(filterBytes: Uint8Array, blockHash: Uint8Array, items: Uint8Array[]): boolean
basicFilterElements(block: BasicFilterBlock): Uint8Array[]

// Headers
filterHash(filterBytes: Uint8Array): Uint8Array          // Hash256(filterBytes)
filterHeader(filterHash: Uint8Array, prevHeader: Uint8Array): Uint8Array
```

`BasicFilterBlock` is a minimal typed shape sufficient for BIP-158 contents rules:
- coinbase detection
- previous output scripts for non-coinbase inputs (supplied alongside or embedded)
- output `scriptPubKey`s with `OP_RETURN` exclusion

Official vectors supply `[Prev Output Scripts for Block]` separately from the raw block hex — the API should support that split (block bytes or decoded txs + prev scripts array).

## Basic filter rules (normative)

For each transaction in a block:
1. Include the previous output script for each input, **except** the coinbase transaction.
2. Include each output `scriptPubKey`, **except** scripts that start with `OP_RETURN` (`0x6a`).
3. Omit nil/empty items.
4. Key `k` = first 16 bytes of the block hash in **internal/little-endian** byte order.
5. Empty filter serializes as a single zero byte (per BIP-158).

## Testing strategy

1. Vendor `testdata/bip158/testnet-19.json` from `bitcoin/bips`.
2. Write failing vector tests **before** implementation:
   - Basic filter bytes match vector `Basic Filter`
   - Filter header matches given `Previous Basic Header` → `Basic Header`
   - Membership consistent with constructed elements from block + prev scripts
3. Unit tests for Golomb-Rice edge cases, empty set, single element, `OP_RETURN` skip, coinbase skip.
4. Scripts: `test`, `typecheck`, `check` (mirror `bip324` discipline).

## Packaging

- `name`: `bip158`
- TypeScript ESM, Bun for tests
- Dependencies: `@noble/hashes` (pin compatible range)
- No `node:` imports under `src/`
- Publish shape later (`tsup` / `prepare`) optional after core is green — not required for v0 correctness

## Success criteria

- Every row in `testnet-19.json` passes (filter bytes + header chain)
- Pure `Uint8Array` API; works under Bun and Node ESM
- No BIP-157 code in this package
- README documents install, basic match example, and vector provenance

/**
 * Minimal Bitcoin block wire decoder — just enough structure (coinbase
 * detection, input count, output scripts) to feed BIP-158 basic filter
 * element extraction. Reimplemented locally in the style of `bip324`'s
 * `PayloadReader`, without depending on it.
 */

import { decodeCompactSize } from "./compact-size.ts";

export type DecodedTxInput = {
  scriptSig: Uint8Array;
};

export type DecodedTxOutput = {
  scriptPubKey: Uint8Array;
};

export type DecodedTx = {
  /** True when the transaction's sole input has a null prevout. */
  isCoinbase: boolean;
  inputs: DecodedTxInput[];
  outputs: DecodedTxOutput[];
};

const BLOCK_HEADER_LENGTH = 80;
const MAX_BLOCK_LENGTH = 4_000_000;
const SEGWIT_MARKER = 0x00;
const SEGWIT_FLAG = 0x01;
const NULL_PREVOUT_INDEX = 0xffff_ffff;
const MIN_TRANSACTION_LENGTH = 60;
const MIN_INPUT_LENGTH = 41;
const MIN_OUTPUT_LENGTH = 9;
const MIN_WITNESS_ITEM_LENGTH = 1;

class BlockReader {
  #offset = 0;

  constructor(private readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length - this.#offset;
  }

  #ensure(length: number): void {
    if (length > this.remaining) {
      throw new Error(
        `unexpected end of block data: wanted ${length} bytes, have ${this.remaining}`,
      );
    }
  }

  u8(): number {
    this.#ensure(1);
    return this.data[this.#offset++]!;
  }

  peekU8(): number {
    this.#ensure(1);
    return this.data[this.#offset]!;
  }

  u32LE(): number {
    this.#ensure(4);
    const value =
      (this.data[this.#offset]! |
        (this.data[this.#offset + 1]! << 8) |
        (this.data[this.#offset + 2]! << 16) |
        (this.data[this.#offset + 3]! << 24)) >>>
      0;
    this.#offset += 4;
    return value;
  }

  bytes(length: number): Uint8Array {
    this.#ensure(length);
    const out = Uint8Array.from(
      this.data.subarray(this.#offset, this.#offset + length),
    );
    this.#offset += length;
    return out;
  }

  skip(length: number): void {
    this.#ensure(length);
    this.#offset += length;
  }

  allZero(length: number): boolean {
    this.#ensure(length);
    let isZero = true;
    for (let i = 0; i < length; i++) {
      if (this.data[this.#offset + i] !== 0) isZero = false;
    }
    this.#offset += length;
    return isZero;
  }

  compactSize(): number {
    const { value, length } = decodeCompactSize(this.data, this.#offset);
    this.#offset += length;
    return value;
  }

  varBytes(): Uint8Array {
    return this.bytes(this.compactSize());
  }

  skipVarBytes(): void {
    this.skip(this.compactSize());
  }
}

type DecodedTransactionDetails = DecodedTx & {
  hasNullPrevout: boolean;
};

function requireCountFits(
  label: string,
  count: number,
  remaining: number,
  minimumItemLength: number,
): void {
  if (count > Math.floor(remaining / minimumItemLength)) {
    throw new Error(
      `${label} ${count} cannot fit in ${remaining} remaining bytes`,
    );
  }
}

function decodeTransaction(reader: BlockReader): DecodedTransactionDetails {
  reader.skip(4); // version

  let hasWitness = false;
  if (reader.peekU8() === SEGWIT_MARKER) {
    reader.u8();
    const flag = reader.u8();
    if (flag !== SEGWIT_FLAG) {
      throw new Error(`unsupported segwit flag byte: 0x${flag.toString(16)}`);
    }
    hasWitness = true;
  }

  const inputCount = reader.compactSize();
  if (inputCount === 0) {
    throw new Error("transaction must contain at least one input");
  }
  requireCountFits(
    "input count",
    inputCount,
    reader.remaining,
    MIN_INPUT_LENGTH,
  );

  const inputs: DecodedTxInput[] = [];
  let nullPrevoutCount = 0;
  for (let i = 0; i < inputCount; i++) {
    const hasZeroTxid = reader.allZero(32);
    const previousOutputIndex = reader.u32LE();
    if (hasZeroTxid && previousOutputIndex === NULL_PREVOUT_INDEX) {
      nullPrevoutCount++;
    }
    const scriptSig = reader.varBytes();
    reader.skip(4); // sequence
    inputs.push({ scriptSig });
  }

  const outputCount = reader.compactSize();
  if (outputCount === 0) {
    throw new Error("transaction must contain at least one output");
  }
  requireCountFits(
    "output count",
    outputCount,
    reader.remaining,
    MIN_OUTPUT_LENGTH,
  );

  const outputs: DecodedTxOutput[] = [];
  for (let i = 0; i < outputCount; i++) {
    reader.skip(8); // value
    const scriptPubKey = reader.varBytes();
    outputs.push({ scriptPubKey });
  }

  if (hasWitness) {
    let hasWitnessStack = false;
    for (let i = 0; i < inputCount; i++) {
      const itemCount = reader.compactSize();
      requireCountFits(
        "witness item count",
        itemCount,
        reader.remaining,
        MIN_WITNESS_ITEM_LENGTH,
      );
      if (itemCount > 0) hasWitnessStack = true;
      for (let j = 0; j < itemCount; j++) {
        reader.skipVarBytes();
      }
    }
    if (!hasWitnessStack) {
      throw new Error("superfluous witness serialization");
    }
  }

  reader.skip(4); // locktime

  return {
    inputs,
    outputs,
    isCoinbase: inputCount === 1 && nullPrevoutCount === 1,
    hasNullPrevout: nullPrevoutCount > 0,
  };
}

/** Decodes just enough of a block's transactions for BIP-158 element extraction. */
export function decodeBlockTransactions(blockBytes: Uint8Array): DecodedTx[] {
  if (blockBytes.length > MAX_BLOCK_LENGTH) {
    throw new Error("block exceeds 4,000,000 bytes");
  }

  const reader = new BlockReader(blockBytes);
  reader.skip(BLOCK_HEADER_LENGTH);

  const txCount = reader.compactSize();
  if (txCount === 0) {
    throw new Error("block must contain at least one transaction");
  }
  requireCountFits(
    "transaction count",
    txCount,
    reader.remaining,
    MIN_TRANSACTION_LENGTH,
  );

  const txs: DecodedTx[] = [];
  for (let i = 0; i < txCount; i++) {
    const { hasNullPrevout, ...tx } = decodeTransaction(reader);
    if (i === 0 && !tx.isCoinbase) {
      throw new Error("first transaction must be coinbase");
    }
    if (i > 0 && tx.isCoinbase) {
      throw new Error("coinbase transaction must be first");
    }
    if (i > 0 && hasNullPrevout) {
      throw new Error(
        "null prevout is only valid in a coinbase transaction",
      );
    }
    txs.push(tx);
  }
  if (reader.remaining !== 0) {
    throw new Error(`trailing block bytes: ${reader.remaining}`);
  }
  return txs;
}

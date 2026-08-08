import { describe, expect, test } from "bun:test";
import { bytesToHex, concatBytes, hexToBytes } from "../../src/crypto/bytes.ts";
import { encodeCompactSize } from "../../src/wire/compact-size.ts";
import { decodeBlockTransactions } from "../../src/wire/block.ts";
import { loadTestnet19 } from "../helpers/vectors.ts";

const GENESIS_OUTPUT_SCRIPT_HEX =
  "4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac";
const BLOCK_HEADER_LENGTH = 80;
const MAX_BLOCK_BYTES = 4_000_000;
const MIN_VALID_TRANSACTION_BYTES = 60;
const EMPTY_BYTES = new Uint8Array(0);

type InputSpec = {
  previousTxid: Uint8Array;
  previousOutputIndex: number;
  scriptSig?: Uint8Array;
};

type OutputSpec = {
  scriptPubKey: Uint8Array;
};

type TxSpec = {
  inputs: InputSpec[];
  outputs: OutputSpec[];
  witnessStacks?: Uint8Array[][];
  witnessFlag?: number;
};

function u32LE(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function varBytes(bytes: Uint8Array): Uint8Array {
  return concatBytes(encodeCompactSize(bytes.length), bytes);
}

function coinbaseInput(): InputSpec {
  return {
    previousTxid: new Uint8Array(32),
    previousOutputIndex: 0xffff_ffff,
  };
}

function regularInput(): InputSpec {
  const previousTxid = new Uint8Array(32);
  previousTxid[0] = 1;
  return { previousTxid, previousOutputIndex: 0 };
}

function serializeInput(input: InputSpec): Uint8Array {
  return concatBytes(
    input.previousTxid,
    u32LE(input.previousOutputIndex),
    varBytes(input.scriptSig ?? EMPTY_BYTES),
    new Uint8Array(4),
  );
}

function serializeOutput(output: OutputSpec): Uint8Array {
  return concatBytes(new Uint8Array(8), varBytes(output.scriptPubKey));
}

function buildTx(spec: TxSpec): Uint8Array {
  const hasWitnessEncoding =
    spec.witnessStacks !== undefined || spec.witnessFlag !== undefined;
  const witnessStacks =
    spec.witnessStacks ?? spec.inputs.map(() => [] as Uint8Array[]);
  if (witnessStacks.length !== spec.inputs.length) {
    throw new Error("test fixture must provide one witness stack per input");
  }

  const witnessParts = witnessStacks.map((stack) =>
    concatBytes(
      encodeCompactSize(stack.length),
      ...stack.map((item) => varBytes(item)),
    ),
  );

  return concatBytes(
    new Uint8Array(4),
    ...(hasWitnessEncoding
      ? [new Uint8Array([0x00, spec.witnessFlag ?? 0x01])]
      : []),
    encodeCompactSize(spec.inputs.length),
    ...spec.inputs.map(serializeInput),
    encodeCompactSize(spec.outputs.length),
    ...spec.outputs.map(serializeOutput),
    ...(hasWitnessEncoding ? witnessParts : []),
    new Uint8Array(4),
  );
}

function buildBlock(txs: Uint8Array[]): Uint8Array {
  return concatBytes(
    new Uint8Array(BLOCK_HEADER_LENGTH),
    encodeCompactSize(txs.length),
    ...txs,
  );
}

function padPastTransactionCountGuard(tx: Uint8Array): Uint8Array {
  if (tx.length >= MIN_VALID_TRANSACTION_BYTES) return tx;
  return concatBytes(
    tx,
    new Uint8Array(MIN_VALID_TRANSACTION_BYTES - tx.length),
  );
}

const EMPTY_OUTPUT: OutputSpec = { scriptPubKey: EMPTY_BYTES };

function buildLargeCoinbaseTx(): Uint8Array {
  return buildTx({
    inputs: [
      {
        ...coinbaseInput(),
        scriptSig: new Uint8Array(64),
      },
    ],
    outputs: [EMPTY_OUTPUT],
  });
}

describe("decodeBlockTransactions", () => {
  const rows = loadTestnet19();

  test("genesis block: single coinbase tx, one input, one output", () => {
    const row = rows.find((r) => r.height === 0)!;
    const txs = decodeBlockTransactions(hexToBytes(row.blockHex));
    expect(txs).toHaveLength(1);
    expect(txs[0]!.isCoinbase).toBe(true);
    expect(txs[0]!.inputs).toHaveLength(1);
    expect(txs[0]!.outputs).toHaveLength(1);
    expect(bytesToHex(txs[0]!.outputs[0]!.scriptPubKey)).toBe(
      GENESIS_OUTPUT_SCRIPT_HEX,
    );
  });

  test("copies decoded scripts from a Buffer-backed block into plain Uint8Arrays", () => {
    const expectedScriptSig = new Uint8Array([0x03, 0x01, 0x02]);
    const expectedScriptPubKey = new Uint8Array([0x51, 0x52]);
    const block = Buffer.from(
      buildBlock([
        buildTx({
          inputs: [
            {
              ...coinbaseInput(),
              scriptSig: expectedScriptSig,
            },
          ],
          outputs: [{ scriptPubKey: expectedScriptPubKey }],
        }),
      ]),
    );

    const txs = decodeBlockTransactions(block);
    const scriptSig = txs[0]!.inputs[0]!.scriptSig;
    const scriptPubKey = txs[0]!.outputs[0]!.scriptPubKey;
    block.fill(0xff);

    expect(scriptSig).toEqual(expectedScriptSig);
    expect(scriptPubKey).toEqual(expectedScriptPubKey);
    expect(scriptSig).not.toBeInstanceOf(Buffer);
    expect(scriptPubKey).not.toBeInstanceOf(Buffer);
  });

  test("a real multi-transaction block flags only its first transaction as coinbase", () => {
    const row = rows.find((r) => r.height === 180480)!;
    const txs = decodeBlockTransactions(hexToBytes(row.blockHex));
    expect(txs).toHaveLength(5);
    expect(txs.map((tx) => tx.isCoinbase)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  test("witness block (height 1263442) decodes without error and stays aligned", () => {
    const row = rows.find((r) => r.height === 1263442)!;
    const txs = decodeBlockTransactions(hexToBytes(row.blockHex));
    expect(txs.length).toBeGreaterThan(0);
    expect(txs[0]!.isCoinbase).toBe(true);
    // Correct alignment through witness data means every non-coinbase input
    // is accounted for exactly once against the vector's prev-scripts count.
    const nonCoinbaseInputCount = txs
      .slice(1)
      .reduce((sum, tx) => sum + tx.inputs.length, 0);
    expect(nonCoinbaseInputCount).toBe(row.prevScriptsHex.length);
  });

  test("decodes every vector block without throwing", () => {
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(() => decodeBlockTransactions(hexToBytes(row.blockHex))).not.toThrow();
    }
  });

  test("rejects every proper prefix of a structurally valid block", () => {
    const tx = buildLargeCoinbaseTx();
    expect(tx.length).toBeGreaterThan(MIN_VALID_TRANSACTION_BYTES);
    const block = buildBlock([tx]);
    expect(() => decodeBlockTransactions(block)).not.toThrow();
    for (let length = 0; length < block.length; length++) {
      expect(() => decodeBlockTransactions(block.subarray(0, length))).toThrow();
    }
  });

  test("rejects a non-canonical transaction count", () => {
    const coinbaseTx = buildTx({
      inputs: [coinbaseInput()],
      outputs: [EMPTY_OUTPUT],
    });
    const block = concatBytes(
      new Uint8Array(BLOCK_HEADER_LENGTH),
      new Uint8Array([0xfd, 0x01, 0x00]),
      coinbaseTx,
    );
    expect(() => decodeBlockTransactions(block)).toThrow(
      /non-canonical CompactSize/,
    );
  });

  test("rejects trailing bytes after the final transaction", () => {
    const block = buildBlock([
      buildTx({ inputs: [coinbaseInput()], outputs: [EMPTY_OUTPUT] }),
    ]);
    expect(() =>
      decodeBlockTransactions(concatBytes(block, new Uint8Array([0x00]))),
    ).toThrow(/trailing block bytes/);
  });

  test("rejects a zero-transaction block", () => {
    expect(() => decodeBlockTransactions(buildBlock([]))).toThrow(
      /block must contain at least one transaction/,
    );
  });

  test("rejects a transaction with zero inputs", () => {
    const tx = buildTx({
      inputs: [],
      outputs: [EMPTY_OUTPUT],
      witnessStacks: [],
    });
    expect(() =>
      decodeBlockTransactions(buildBlock([padPastTransactionCountGuard(tx)])),
    ).toThrow(/transaction must contain at least one input/);
  });

  test("rejects a transaction with zero outputs", () => {
    const tx = buildTx({ inputs: [coinbaseInput()], outputs: [] });
    expect(() =>
      decodeBlockTransactions(buildBlock([padPastTransactionCountGuard(tx)])),
    ).toThrow(/transaction must contain at least one output/);
  });

  test("rejects a first transaction that is not structurally coinbase", () => {
    const tx = buildTx({ inputs: [regularInput()], outputs: [EMPTY_OUTPUT] });
    expect(() => decodeBlockTransactions(buildBlock([tx]))).toThrow(
      /first transaction must be coinbase/,
    );
  });

  test("rejects an additional coinbase transaction", () => {
    const coinbaseTx = buildTx({
      inputs: [coinbaseInput()],
      outputs: [EMPTY_OUTPUT],
    });
    expect(() =>
      decodeBlockTransactions(buildBlock([coinbaseTx, coinbaseTx])),
    ).toThrow(/coinbase transaction must be first/);
  });

  test("rejects a null prevout in a multi-input non-coinbase transaction", () => {
    const coinbaseTx = buildTx({
      inputs: [coinbaseInput()],
      outputs: [EMPTY_OUTPUT],
    });
    const malformedTx = buildTx({
      inputs: [regularInput(), coinbaseInput()],
      outputs: [EMPTY_OUTPUT],
    });
    expect(() =>
      decodeBlockTransactions(buildBlock([coinbaseTx, malformedTx])),
    ).toThrow(/null prevout is only valid in a coinbase transaction/);
  });

  test("rejects an unknown witness flag", () => {
    const tx = buildTx({
      inputs: [coinbaseInput()],
      outputs: [EMPTY_OUTPUT],
      witnessFlag: 0x02,
    });
    expect(() => decodeBlockTransactions(buildBlock([tx]))).toThrow(
      /unsupported segwit flag byte: 0x2/,
    );
  });

  test("rejects a truncated witness flag", () => {
    const truncatedTx = concatBytes(
      new Uint8Array(4),
      new Uint8Array([0x00]),
    );
    const block = buildBlock([buildLargeCoinbaseTx(), truncatedTx]);
    expect(() => decodeBlockTransactions(block)).toThrow(
      /unexpected end of block data/,
    );
  });

  test("rejects witness serialization when every input stack is empty", () => {
    const tx = buildTx({
      inputs: [coinbaseInput()],
      outputs: [EMPTY_OUTPUT],
      witnessStacks: [[]],
    });
    expect(() => decodeBlockTransactions(buildBlock([tx]))).toThrow(
      /superfluous witness serialization/,
    );
  });

  test("accepts a witness stack containing one empty item", () => {
    const tx = buildTx({
      inputs: [coinbaseInput()],
      outputs: [EMPTY_OUTPUT],
      witnessStacks: [[EMPTY_BYTES]],
    });
    const decoded = decodeBlockTransactions(buildBlock([tx]));
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.isCoinbase).toBe(true);
  });

  test("rejects a block larger than 4,000,000 bytes", () => {
    expect(() =>
      decodeBlockTransactions(new Uint8Array(MAX_BLOCK_BYTES + 1)),
    ).toThrow(/block exceeds 4,000,000 bytes/);
  });

  test("rejects an impossible transaction count before its loop", () => {
    const block = concatBytes(
      new Uint8Array(BLOCK_HEADER_LENGTH),
      encodeCompactSize(Number.MAX_SAFE_INTEGER),
    );
    expect(() => decodeBlockTransactions(block)).toThrow(
      /transaction count .* cannot fit in .* remaining bytes/,
    );
  });

  test("rejects an impossible input count before its loop", () => {
    const tx = padPastTransactionCountGuard(
      concatBytes(
        new Uint8Array(4),
        encodeCompactSize(Number.MAX_SAFE_INTEGER),
      ),
    );
    const block = buildBlock([tx]);
    expect(() => decodeBlockTransactions(block)).toThrow(
      /input count .* cannot fit in .* remaining bytes/,
    );
  });

  test("rejects an impossible output count before its loop", () => {
    const tx = padPastTransactionCountGuard(
      concatBytes(
        new Uint8Array(4),
        encodeCompactSize(1),
        serializeInput(coinbaseInput()),
        encodeCompactSize(Number.MAX_SAFE_INTEGER),
      ),
    );
    const block = buildBlock([tx]);
    expect(() => decodeBlockTransactions(block)).toThrow(
      /output count .* cannot fit in .* remaining bytes/,
    );
  });

  test("rejects an impossible witness-item count before its loop", () => {
    const block = concatBytes(
      new Uint8Array(BLOCK_HEADER_LENGTH),
      encodeCompactSize(1),
      new Uint8Array(4),
      new Uint8Array([0x00, 0x01]),
      encodeCompactSize(1),
      serializeInput(coinbaseInput()),
      encodeCompactSize(1),
      serializeOutput(EMPTY_OUTPUT),
      encodeCompactSize(Number.MAX_SAFE_INTEGER),
    );
    expect(() => decodeBlockTransactions(block)).toThrow(
      /witness item count .* cannot fit in .* remaining bytes/,
    );
  });
});

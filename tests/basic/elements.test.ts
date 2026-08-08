import { describe, expect, test } from "bun:test";
import { bytesToHex, concatBytes, hexToBytes } from "../../src/crypto/bytes.ts";
import { encodeCompactSize } from "../../src/wire/compact-size.ts";
import { basicFilterElements } from "../../src/basic/elements.ts";
import { buildBasicFilter } from "../../src/basic/filter.ts";
import { loadTestnet19 } from "../helpers/vectors.ts";

const GENESIS_OUTPUT_SCRIPT_HEX =
  "4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac";

function varBytes(bytes: Uint8Array): Uint8Array {
  return concatBytes(encodeCompactSize(bytes.length), bytes);
}

/** Builds a minimal, header-agnostic block (80 zero-byte header) with the given txs. */
function buildBlock(txs: Uint8Array[]): Uint8Array {
  return concatBytes(
    new Uint8Array(80),
    encodeCompactSize(txs.length),
    ...txs,
  );
}

type InputSpec = { coinbase?: boolean; scriptSig?: Uint8Array };
type OutputSpec = { scriptPubKey: Uint8Array };

function buildTx(inputs: InputSpec[], outputs: OutputSpec[]): Uint8Array {
  const inputParts = inputs.map((input) => {
    const previousTxid = new Uint8Array(32);
    if (!input.coinbase) previousTxid[0] = 1;
    return concatBytes(
      previousTxid,
      input.coinbase
        ? new Uint8Array([0xff, 0xff, 0xff, 0xff])
        : new Uint8Array(4),
      varBytes(input.scriptSig ?? new Uint8Array(0)),
      new Uint8Array(4), // sequence
    );
  });
  const outputParts = outputs.map((output) =>
    concatBytes(new Uint8Array(8), varBytes(output.scriptPubKey)),
  );
  return concatBytes(
    new Uint8Array(4), // version
    encodeCompactSize(inputs.length),
    ...inputParts,
    encodeCompactSize(outputs.length),
    ...outputParts,
    new Uint8Array(4), // locktime
  );
}

const OP_TRUE = hexToBytes("51");
const NORMAL_SCRIPT_A = hexToBytes("76a914aabbccddeeff00112233445566778899aabbccdd88ac");
const NORMAL_SCRIPT_B = hexToBytes("76a914000102030405060708090a0b0c0d0e0f1011121388ac");
const OP_RETURN_SCRIPT = hexToBytes("6a0648656c6c6f21");
const EMPTY_SCRIPT = new Uint8Array(0);

describe("basicFilterElements", () => {
  test("genesis block yields exactly the single coinbase output script", () => {
    const row = loadTestnet19().find((r) => r.height === 0)!;
    const elements = basicFilterElements({
      blockBytes: hexToBytes(row.blockHex),
      prevOutputScripts: row.prevScriptsHex.map(hexToBytes),
    });
    expect(elements).toHaveLength(1);
    expect(bytesToHex(elements[0]!)).toBe(GENESIS_OUTPUT_SCRIPT_HEX);
  });

  test("skips coinbase inputs (no prev scripts consumed for tx 0)", () => {
    const coinbaseTx = buildTx(
      [{ coinbase: true }],
      [{ scriptPubKey: OP_TRUE }],
    );
    const block = buildBlock([coinbaseTx]);
    const elements = basicFilterElements({
      blockBytes: block,
      prevOutputScripts: [],
    });
    expect(elements).toEqual([OP_TRUE]);
  });

  test("excludes OP_RETURN outputs and empty scripts; includes non-coinbase prev scripts", () => {
    const coinbaseTx = buildTx(
      [{ coinbase: true }],
      [{ scriptPubKey: OP_TRUE }],
    );
    const normalTx = buildTx(
      [{}],
      [
        { scriptPubKey: OP_RETURN_SCRIPT },
        { scriptPubKey: NORMAL_SCRIPT_B },
        { scriptPubKey: EMPTY_SCRIPT },
      ],
    );
    const block = buildBlock([coinbaseTx, normalTx]);

    const elements = basicFilterElements({
      blockBytes: block,
      prevOutputScripts: [NORMAL_SCRIPT_A],
    });

    expect(elements).toEqual([OP_TRUE, NORMAL_SCRIPT_A, NORMAL_SCRIPT_B]);
  });

  test("copies Uint8Array- and Buffer-backed prev scripts in element order", () => {
    const plainPrevScript = new Uint8Array([0x51, 0x01]);
    const bufferPrevScript = Buffer.from([0x52, 0x02]);
    const expectedPlainPrevScript = Uint8Array.from(plainPrevScript);
    const expectedBufferPrevScript = Uint8Array.from(bufferPrevScript);
    const coinbaseTx = buildTx(
      [{ coinbase: true }],
      [{ scriptPubKey: OP_TRUE }],
    );
    const normalTx = buildTx(
      [{}, {}],
      [{ scriptPubKey: OP_RETURN_SCRIPT }],
    );

    const elements = basicFilterElements({
      blockBytes: buildBlock([coinbaseTx, normalTx]),
      prevOutputScripts: [plainPrevScript, bufferPrevScript],
    });
    plainPrevScript.fill(0xff);
    bufferPrevScript.fill(0xff);

    expect(elements).toEqual([
      OP_TRUE,
      expectedPlainPrevScript,
      expectedBufferPrevScript,
    ]);
    expect(elements[1]).not.toBe(plainPrevScript);
    expect(elements[2]).not.toBe(bufferPrevScript);
    expect(elements[1]).not.toBeInstanceOf(Buffer);
    expect(elements[2]).not.toBeInstanceOf(Buffer);
  });

  test("omits an empty prev output script", () => {
    const coinbaseTx = buildTx(
      [{ coinbase: true }],
      [{ scriptPubKey: OP_TRUE }],
    );
    const normalTx = buildTx([{}], [{ scriptPubKey: NORMAL_SCRIPT_B }]);
    const block = buildBlock([coinbaseTx, normalTx]);

    const elements = basicFilterElements({
      blockBytes: block,
      prevOutputScripts: [EMPTY_SCRIPT],
    });

    expect(elements).toEqual([OP_TRUE, NORMAL_SCRIPT_B]);
  });

  test("throws when prevOutputScripts count does not match non-coinbase input count", () => {
    const coinbaseTx = buildTx(
      [{ coinbase: true }],
      [{ scriptPubKey: OP_TRUE }],
    );
    const normalTx = buildTx([{}], [{ scriptPubKey: NORMAL_SCRIPT_B }]);
    const block = buildBlock([coinbaseTx, normalTx]);

    expect(() =>
      basicFilterElements({ blockBytes: block, prevOutputScripts: [] }),
    ).toThrow();
    expect(() =>
      basicFilterElements({
        blockBytes: block,
        prevOutputScripts: [NORMAL_SCRIPT_A, NORMAL_SCRIPT_A],
      }),
    ).toThrow();
  });

  test("witness block (height 1263442) extracts elements that rebuild the official filter", () => {
    const row = loadTestnet19().find((r) => r.height === 1263442)!;
    const prevScripts = row.prevScriptsHex.map(hexToBytes);
    const elements = basicFilterElements({
      blockBytes: hexToBytes(row.blockHex),
      prevOutputScripts: prevScripts,
    });

    // One prev-script input + non-OP_RETURN outputs from the vector block.
    expect(prevScripts).toHaveLength(1);
    expect(elements).toHaveLength(3);
    expect(elements).toContainEqual(prevScripts[0]!);

    const filterBytes = buildBasicFilter({
      blockHashDisplay: hexToBytes(row.blockHashHex),
      elements,
    });
    expect(bytesToHex(filterBytes)).toBe(row.basicFilterHex);
  });
});

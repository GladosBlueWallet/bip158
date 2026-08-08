import { decodeBlockTransactions } from "../wire/block.ts";

export type BasicFilterBlockInput = {
  blockBytes: Uint8Array;
  /** Previous output scripts for all non-coinbase inputs, in block order. */
  prevOutputScripts: Uint8Array[];
};

const OP_RETURN = 0x6a;

/**
 * Extracts the BIP-158 basic filter elements from a block: previous output
 * scripts for every non-coinbase input, plus each output `scriptPubKey`
 * except `OP_RETURN`-prefixed and empty scripts.
 */
export function basicFilterElements(
  input: BasicFilterBlockInput,
): Uint8Array[] {
  const txs = decodeBlockTransactions(input.blockBytes);
  const elements: Uint8Array[] = [];
  let prevScriptIndex = 0;

  for (const tx of txs) {
    if (!tx.isCoinbase) {
      for (let i = 0; i < tx.inputs.length; i++) {
        if (prevScriptIndex >= input.prevOutputScripts.length) {
          throw new Error(
            "prevOutputScripts has fewer entries than non-coinbase inputs",
          );
        }
        const script = input.prevOutputScripts[prevScriptIndex++]!;
        if (script.length > 0) elements.push(Uint8Array.from(script));
      }
    }

    for (const output of tx.outputs) {
      const script = output.scriptPubKey;
      if (script.length === 0) continue;
      if (script[0] === OP_RETURN) continue;
      elements.push(script);
    }
  }

  if (prevScriptIndex !== input.prevOutputScripts.length) {
    throw new Error(
      `prevOutputScripts count mismatch: consumed ${prevScriptIndex}, provided ${input.prevOutputScripts.length}`,
    );
  }

  return elements;
}

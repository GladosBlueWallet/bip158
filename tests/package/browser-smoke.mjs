import {
  buildBasicFilter,
  bytesToHex,
  hexToBytes,
  matchAnyBasicFilters,
} from "bip158";

const blockHashDisplay = hexToBytes(
  "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943",
);
const coinbaseScript = hexToBytes(
  "4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac",
);
const filter = buildBasicFilter({
  blockHashDisplay,
  elements: [coinbaseScript],
});

if (bytesToHex(filter) !== "019dfca8") {
  throw new Error("browser bundle produced the wrong basic filter");
}
if (
  !matchAnyBasicFilters([filter], [blockHashDisplay], [coinbaseScript])[0]
) {
  throw new Error("browser bundle could not match its basic filter");
}

export const browserSmokePassed = true;

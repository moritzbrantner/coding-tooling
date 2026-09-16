import { readFileSync } from "node:fs";

import { format } from "oxfmt";

const path = "src/expectation-gap-detectors.ts";
const source = readFileSync(path, "utf8");
const { code } = await format(path, source, {
  printWidth: 100,
  singleQuote: false,
  semi: true,
  trailingComma: "all",
});

console.log(`FORMATTED_BASE64=${Buffer.from(code, "utf8").toString("base64")}`);
process.exit(1);

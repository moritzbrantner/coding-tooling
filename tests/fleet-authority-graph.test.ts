import { expect, test } from "bun:test";

import { parseAuthorityBoundaries } from "../src/fleet-authority-graph.ts";

test("parses the standard AGENTS authority boundary section", () => {
  expect(
    parseAuthorityBoundaries(`# Agent guidance

## Authority boundaries

- Owns: \`physics/contact\`, \`physics/collision\`
- Adapts: \`game-server/lobby\`
- Non-authoritative: \`balance-simulation\`
- Prohibited write-back: browser projection must not replace simulation state

## Change discipline

- Verify changes.
`),
  ).toEqual({
    owns: ["physics/collision", "physics/contact"],
    adapts: ["game-server/lobby"],
    nonAuthoritative: ["balance-simulation"],
    prohibitedWriteBack: ["browser projection must not replace simulation state"],
  });
});

test("parses an authority section at end of file", () => {
  expect(
    parseAuthorityBoundaries(`## Authority boundaries
- Owns: \`streaming/checkpoints\`
`)?.owns,
  ).toEqual(["streaming/checkpoints"]);
});

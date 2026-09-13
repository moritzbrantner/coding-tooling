import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fleetAuthorityGraph, parseAuthorityBoundaries } from "../src/fleet-authority-graph.ts";

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

test("fails a local-only source graph when the configured checkout is absent", () => {
  const fleet = mkdtempSync(join(tmpdir(), "coding-tooling-authority-"));
  const repository = join(fleet, "consumer");
  mkdirSync(join(repository, ".git"), { recursive: true });
  writeFileSync(
    join(repository, ".coding-tooling.source-deps.json"),
    JSON.stringify({
      schemaVersion: 2,
      cargo: {
        localOnly: true,
        patches: [
          {
            package: "foundation",
            git: "https://github.com/example/foundation.git",
            rev: "0123456789abcdef0123456789abcdef01234567",
            localPath: "../foundation",
          },
        ],
      },
    }),
  );

  const result = fleetAuthorityGraph(fleet);
  expect(result.status).toBe("failed");
  expect(result.diagnostics.map((entry) => entry.code)).toContain(
    "authority-graph-local-source-missing",
  );
});

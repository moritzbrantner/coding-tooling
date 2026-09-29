import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fleetAuthorityGraph, parseAuthorityBoundaries } from "../src/fleet-authority-graph.ts";

function repository(root: string, name: string, metadata: string, agents?: string): string {
  const path = join(root, name);
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".repository.toml"), metadata);
  if (agents) writeFileSync(join(path, "AGENTS.md"), agents);
  return path;
}

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

test("describes repository dependencies and ignores source-checkout validation state", () => {
  const fleet = mkdtempSync(join(tmpdir(), "coding-tooling-authority-"));
  const consumer = repository(
    fleet,
    "consumer",
    `schema_version = 1
id = "example/consumer"
kind = "app"
status = "active"
depends_on = ["example/foundation"]
consumed_by = []
supersedes = []
replaced_by = []
`,
    `## Authority boundaries
- Adapts: \`foundation/runtime\`
`,
  );
  writeFileSync(
    join(consumer, ".coding-tooling.source-deps.json"),
    JSON.stringify({
      schemaVersion: 2,
      cargo: {
        localOnly: true,
        patches: [
          {
            package: "foundation",
            git: "https://github.com/example/foundation.git",
            rev: "0123456789abcdef0123456789abcdef01234567",
            localPath: "../missing-foundation",
          },
        ],
      },
    }),
  );

  const result = fleetAuthorityGraph(fleet);

  expect(result.status).toBe("passed");
  expect(result.diagnostics).toEqual([]);
  expect(result.data.dependencyEdges).toEqual([
    { from: "example/consumer", to: "example/foundation", kind: "depends-on" },
  ]);
  expect((result.data.repositories as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
    "sourceDependencies",
  );
});

test("reports duplicate authority as a conflict without turning the graph into a gate", () => {
  const fleet = mkdtempSync(join(tmpdir(), "coding-tooling-authority-conflict-"));
  const metadata = (id: string) => `schema_version = 1
id = "${id}"
kind = "library"
status = "active"
depends_on = []
consumed_by = []
supersedes = []
replaced_by = []
`;
  repository(
    fleet,
    "left",
    metadata("example/left"),
    `## Authority boundaries
- Owns: \`physics/collision\`
`,
  );
  repository(
    fleet,
    "right",
    metadata("example/right"),
    `## Authority boundaries
- Owns: \`physics/collision\`
`,
  );

  const result = fleetAuthorityGraph(fleet);

  expect(result.status).toBe("passed");
  expect(result.diagnostics).toEqual([]);
  expect(result.data.conflicts).toEqual([
    {
      kind: "duplicate-authority-owner",
      capability: "physics/collision",
      repositories: ["example/left", "example/right"],
    },
  ]);
});

test("contains malformed repository metadata as a descriptive adoption gap", () => {
  const fleet = mkdtempSync(join(tmpdir(), "coding-tooling-authority-malformed-"));
  repository(
    fleet,
    "broken",
    `schema_version = 1
id = "example/broken"
kind = "library"
status = "active"
summary = "\\x"
depends_on = []
consumed_by = []
supersedes = []
replaced_by = []
`,
  );

  const result = fleetAuthorityGraph(fleet);
  const repositories = result.data.repositories as Array<{
    metadata: unknown;
    metadataDiagnostics: Array<{ code?: string }>;
  }>;

  expect(result.status).toBe("passed");
  expect(repositories[0]?.metadata).toBeNull();
  expect(repositories[0]?.metadataDiagnostics).toEqual([
    expect.objectContaining({ code: "repository-metadata-unreadable" }),
  ]);
});

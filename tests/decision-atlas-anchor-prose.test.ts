// Regression for a PR #339 review finding: anchor markers inside inline code are prose.
import { expect, test } from "bun:test";

import { buildAtlasIndex } from "../src/decision-atlas.ts";

const atlas = (child: string) => `# Decision Atlas

## Entries

- **1** Product
  - **1.1** Evidence
    - **1.1.1** [decision] Help documents anchors.
      ${child}
`;

function evidence(child: string) {
  const index = buildAtlasIndex("moritzbrantner/prose-fixture", "0".repeat(40), [
    { path: "docs/decisions/atlas.md", format: "numbered-list", text: atlas(child) },
  ]);
  return index.decisions.find((entry) => entry.id === "1.1.1")!.evidence ?? [];
}

test("a literal anchor marker inside inline code stays evidence text", () => {
  const items = evidence("- [x] Help shows `x — src: foo.rs::bar` literally.");
  expect(items).toHaveLength(1);
  expect(items[0]!.text).toBe("Help shows `x — src: foo.rs::bar` literally.");
  expect((items[0] as { anchors?: unknown[] }).anchors ?? []).toEqual([]);
});

test("a real anchor tail after inline code is still parsed", () => {
  const items = evidence("- [x] Help shows `x — src: a.rs::b` — src: src/help.rs::render");
  expect(items[0]!.text).toBe("Help shows `x — src: a.rs::b`");
  expect((items[0] as { anchors?: { path?: string; symbol?: string }[] }).anchors).toEqual([
    expect.objectContaining({ kind: "src", path: "src/help.rs", symbol: "render" }),
  ]);
});

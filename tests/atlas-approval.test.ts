import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

import { buildAtlasIndex } from "../src/decision-atlas.ts";

// #348: every written Decision is approved; `[x]`/`[ ]` mean built/not built only.
// The former approval-checklist layout fails with a migration message.
test("the retired approval-checklist layout fails with a migration message", () => {
  const text = execFileSync(
    "git",
    ["show", "HEAD:fixtures/decision-atlas/video-to-3d/DECISION-ATLAS.md"],
    { cwd: new URL("../", import.meta.url), encoding: "utf8" },
  );
  expect(() =>
    buildAtlasIndex("moritzbrantner/video-to-3d", "9e66e206362d74bc855bc66064bef6e4287f6e1b", [
      { path: "docs/DECISION-ATLAS.md", format: "numbered-list", text },
    ]),
  ).toThrow(/approval checkboxes are retired.*\[x\]\/\[ \] only for built/su);
});

test("a compact approval checklist is rejected, the same Atlas without boxes indexes", () => {
  const checklist = "# Decision Atlas\n## 1. Topic\n- [x] **1.1** Approved decision.\n";
  const index = (text: string) =>
    buildAtlasIndex("moritzbrantner/example", "a".repeat(40), [
      { path: "docs/decisions/atlas.md", format: "numbered-list", text },
    ]);
  expect(() => index(checklist)).toThrow("approval checkboxes are retired");
  const migrated = index(
    "# Decision Atlas\n\n## Entries\n\n- **1** Topic\n  - **1.1** Area\n    - **1.1.1** [decision] Approved decision.\n",
  );
  expect(migrated.decisions.map((entry) => [entry.id, entry.decisionStatus])).toEqual([
    ["1.1.1", "accepted"],
  ]);
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { conventionRegistryCommand } from "../src/convention-registry.ts";

function workspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, content);
}

function registry(): string {
  const root = workspace("convention-index-");
  write(root, "README.md", "# Convention test registry\n");
  write(
    root,
    "principles/README.md",
    "# Principles\n\n## PRINCIPLE-001 — Prefer explicit decisions\n\n- Prefer explicit inputs over hidden inference.\n",
  );
  write(
    root,
    "conventions/testing/README.md",
    "# Testing\n\n## TEST-001 — Test observable behavior\n\n- Prove behavior through a stable public seam.\n\n- Avoid private implementation assertions.\n",
  );
  write(
    root,
    "conventions/testing/detail.md",
    "# Detail\n\n## TEST-001 — Test observable behavior\n\n- This duplicate detail must not create another briefing entry.\n",
  );
  write(
    root,
    "technologies/typescript/react/README.md",
    "# React\n\n## REACT-001 — Keep state local\n\n- Own state in the smallest subtree that needs it.\n",
  );
  write(
    root,
    "registry/registry.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        modules: {
          base: {
            sources: ["principles/README.md", "conventions/testing"],
            dependencies: [],
          },
          react: {
            sources: ["technologies/typescript/react/README.md"],
            dependencies: ["base"],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

describe("installed convention index", () => {
  test("generates a compact rule briefing before module navigation", () => {
    const source = registry();
    const target = workspace("convention-consumer-");
    try {
      const result = conventionRegistryCommand("init", ["react"], {
        root: target,
        conventionsRoot: source,
      });
      expect(result.status).toBe("passed");

      const index = readFileSync(join(target, ".conventions/index.md"), "utf8");
      expect(index).toContain("## Rule briefing");
      expect(index).toContain(
        "**PRINCIPLE-001 — Prefer explicit decisions** — Prefer explicit inputs over hidden inference.",
      );
      expect(index).toContain(
        "**TEST-001 — Test observable behavior** — Prove behavior through a stable public seam.",
      );
      expect(index).toContain(
        "**REACT-001 — Keep state local** — Own state in the smallest subtree that needs it.",
      );
      expect(index.match(/\*\*TEST-001 —/g)).toHaveLength(1);
      expect(index).toContain("[details](modules/react/technologies/typescript/react/README.md)");
      expect(index.indexOf("## Rule briefing")).toBeLessThan(index.indexOf("## Installed modules"));
      expect(index).toContain("### base");
      expect(index).toContain("### react");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

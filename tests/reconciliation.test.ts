import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";

import { conventionRegistryCommand } from "../src/convention-registry.ts";
import { writeExpectationConfig } from "../src/expectation-model.ts";
import { reconcileTextFile } from "../src/reconciliation.ts";
import { sourceDependencies } from "../src/source-deps.ts";

function workspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function conventionSource(): string {
  const root = workspace("coding-tooling-convention-source-");
  write(root, "conventions/testing/README.md", "## TEST-001 — Test narrowly\n\n- Keep tests focused.\n");
  write(
    root,
    "registry/registry.json",
    `${JSON.stringify({
      schemaVersion: 1,
      modules: {
        testing: { sources: ["conventions/testing"], dependencies: [] },
      },
    }, null, 2)}\n`,
  );
  return root;
}

describe("deterministic reconciliation", () => {
  test("text reconciliation changes once and then becomes a verified no-op", () => {
    const root = workspace("coding-tooling-reconcile-");
    try {
      const path = join(root, "generated", "state.txt");
      expect(reconcileTextFile(path, "desired\n")).toBe("created");
      expect(reconcileTextFile(path, "desired\n")).toBe("unchanged");
      expect(readFileSync(path, "utf8")).toBe("desired\n");
      expect(reconcileTextFile(path, "next\n")).toBe("changed");
      expect(reconcileTextFile(path, "next\n")).toBe("unchanged");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("expectation configuration only writes when desired state changes", () => {
    const root = workspace("coding-tooling-expectation-reconcile-");
    try {
      expect(writeExpectationConfig(root, { schemaVersion: 1 })).toBe("created");
      expect(writeExpectationConfig(root, { schemaVersion: 1 })).toBe("unchanged");
      expect(writeExpectationConfig(root, { schemaVersion: 1, baseline: [] })).toBe("changed");
      expect(writeExpectationConfig(root, { schemaVersion: 1, baseline: [] })).toBe("unchanged");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("source dependency activation reports zero work on the second application", () => {
    const root = workspace("coding-tooling-source-reconcile-");
    try {
      writeFileSync(
        join(root, ".coding-tooling.source-deps.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          cargo: {
            patches: [
              {
                package: "example",
                git: "https://github.com/example/source.git",
                rev: "1111111111111111111111111111111111111111",
              },
            ],
          },
        })}\n`,
      );

      const first = sourceDependencies(root, "activate");
      const second = sourceDependencies(root, "activate");
      expect(first.status).toBe("passed");
      expect(first.data.changed).toBe(true);
      expect(first.data.reconciliation).toBe("created");
      expect(second.status).toBe("passed");
      expect(second.data.changed).toBe(false);
      expect(second.data.reconciliation).toBe("unchanged");

      const firstDeactivate = sourceDependencies(root, "deactivate");
      const secondDeactivate = sourceDependencies(root, "deactivate");
      expect(firstDeactivate.data.changed).toBe(true);
      expect(firstDeactivate.data.reconciliation).toBe("changed");
      expect(secondDeactivate.data.changed).toBe(false);
      expect(secondDeactivate.data.reconciliation).toBe("unchanged");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("convention updates preserve unchanged files and reconcile only affected state", () => {
    const source = conventionSource();
    const root = workspace("coding-tooling-convention-reconcile-");
    try {
      const initialized = conventionRegistryCommand("init", ["testing"], {
        root,
        conventionsRoot: source,
      });
      expect(initialized.status).toBe("passed");
      expect(initialized.data.changed).toBe(true);

      const unchanged = conventionRegistryCommand("update", [], {
        root,
        conventionsRoot: source,
      });
      expect(unchanged.status).toBe("passed");
      expect(unchanged.data.changed).toBe(false);
      expect(unchanged.data.reconciliation).toBe("unchanged");
      expect((unchanged.data.verified as string[]).length).toBeGreaterThan(0);

      write(source, "README.md", "unrelated source change\n");
      const unrelated = conventionRegistryCommand("update", [], {
        root,
        conventionsRoot: source,
      });
      expect(unrelated.data.changed).toBe(false);

      write(
        source,
        "conventions/testing/README.md",
        "## TEST-001 — Test narrowly\n\n- Keep tests focused.\n\nAdditional detail.\n",
      );
      const relevant = conventionRegistryCommand("update", [], {
        root,
        conventionsRoot: source,
      });
      expect(relevant.status).toBe("passed");
      expect(relevant.data.changed).toBe(true);
      expect(relevant.data.changedFiles).toEqual([
        "modules/testing/conventions/testing/README.md",
      ]);
      expect(relevant.data.created).toEqual([]);
      expect(relevant.data.removed).toEqual([]);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

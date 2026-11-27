import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { adoptionCommand } from "../src/adoption.ts";
import { conventionRegistryCommand } from "../src/convention-registry.ts";

function write(root: string, path: string, content: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function fixture(run: (root: string, source: string) => void): void {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), "coding-tooling-adoption-"));
  const root = join(workspace, "consumer");
  const source = join(workspace, "conventions");
  mkdirSync(root);
  try {
    write(source, "README.md", "# Conventions\n");
    write(source, "principles/README.md", "## PRINCIPLE-001 — Be explicit\n");
    write(source, "conventions/README.md", "## REPO-001 — Preserve local guidance\n");
    write(source, "technologies/rust/README.md", "## RUST-001 — Rust rule\n");
    write(
      source,
      "registry/registry.json",
      JSON.stringify({
        schemaVersion: 1,
        modules: {
          base: { sources: ["principles", "conventions"], dependencies: [] },
          rust: { sources: ["technologies/rust"], dependencies: ["base"] },
          dependencies: { sources: [], dependencies: ["base"] },
          environment: { sources: [], dependencies: ["base"] },
          git: { sources: [], dependencies: ["base"] },
        },
      }),
    );
    run(root, source);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function plan(root: string, source: string) {
  const result = adoptionCommand("plan", { root, conventionsRoot: source });
  expect(result.status).toBe("passed");
  return result.data.groups as { id: string; approval: string; additions?: string[] }[];
}

function apply(root: string, source: string, group: string, approval: string) {
  return adoptionCommand("apply", { root, conventionsRoot: source, group, approval });
}

describe("explicit repository adoption", () => {
  test("plans independent convention groups and installs only the approved technology selection", () => {
    fixture((root, source) => {
      write(root, "Cargo.toml", '[package]\nname = "pilot"\nversion = "0.1.0"\n');
      write(root, "AGENTS.md", "# Local exception\n\nUse the owner-defined contract.\n");
      const groups = plan(root, source);
      expect(existsSync(join(root, "conventions.json"))).toBe(false);
      expect(groups).toContainEqual(
        expect.objectContaining({ id: "technology-conventions", additions: ["rust"] }),
      );
      const technology = groups.find((group) => group.id === "technology-conventions")!;
      const discretionary = groups.find((group) => group.id === "review-conventions")!;
      expect(apply(root, source, technology.id, technology.approval).status).toBe("passed");
      expect(conventionRegistryCommand("check", [], { root }).status).toBe("passed");
      expect(JSON.parse(readFileSync(join(root, "conventions.json"), "utf8")).modules).toEqual([
        "rust",
      ]);
      expect(apply(root, source, discretionary.id, discretionary.approval).status).toBe("failed");
      expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("Local exception");
      expect(plan(root, source).some((group) => group.id === technology.id)).toBe(false);
    });
  });

  test("scaffolds actual package and crate scopes without rewriting substantive instructions", () => {
    fixture((root, source) => {
      write(root, "AGENTS.md", "# Root invariant\n");
      write(root, "Cargo.toml", '[workspace]\nmembers = ["crates/a", "crates/b"]\n');
      write(root, "crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\n');
      write(root, "crates/b/Cargo.toml", '[package]\nname = "b"\nversion = "0.1.0"\n');
      write(root, "crates/b/CLAUDE.md", "# Existing unique guidance\n");
      const group = plan(root, source).find((item) => item.id === "instructions")!;
      expect(existsSync(join(root, "crates/a/AGENTS.md"))).toBe(false);
      expect(apply(root, source, group.id, group.approval).status).toBe("passed");
      expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
      expect(readFileSync(join(root, "crates/a/CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
      expect(readFileSync(join(root, "crates/a/AGENTS.md"), "utf8")).toContain("Cargo.toml");
      expect(existsSync(join(root, "crates/b/AGENTS.md"))).toBe(false);
      expect(readFileSync(join(root, "crates/b/CLAUDE.md"), "utf8")).toBe(
        "# Existing unique guidance\n",
      );
      expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("# Root invariant\n");
      expect(plan(root, source).some((item) => item.id === "instructions")).toBe(false);
    });
  });

  test("rejects a stale instruction plan before creating any file", () => {
    fixture((root, source) => {
      write(root, "AGENTS.md", "# Original\n");
      const group = plan(root, source).find((item) => item.id === "instructions")!;
      write(root, "AGENTS.md", "# Changed\n");
      expect(apply(root, source, group.id, group.approval).status).toBe("failed");
      expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
    });
  });

  test("blocks managed cache drift and unsafe destination links", () => {
    fixture((root, source) => {
      write(root, "Cargo.toml", '[package]\nname = "pilot"\nversion = "0.1.0"\n');
      expect(conventionRegistryCommand("init", ["rust"], { root, conventionsRoot: source }).status)
        .toBe("passed");
      write(root, ".conventions/index.md", "Manual change\n");
      write(source, "outside.md", "Outside\n");
      symlinkSync(join(source, "outside.md"), join(root, "AGENTS.md"));
      const result = adoptionCommand("plan", { root, conventionsRoot: source });
      expect(result.data.conventions).toMatchObject({ status: "blocked" });
      expect(result.data.groups).toEqual([]);
      expect(readFileSync(join(source, "outside.md"), "utf8")).toBe("Outside\n");
    });
  });

  test("refresh is explicit and a changed authority invalidates an old approval", () => {
    fixture((root, source) => {
      write(root, "Cargo.toml", '[package]\nname = "pilot"\nversion = "0.1.0"\n');
      expect(conventionRegistryCommand("init", ["rust"], { root, conventionsRoot: source }).status)
        .toBe("passed");
      write(source, "technologies/rust/README.md", "## RUST-001 — New rule\n");
      const refresh = plan(root, source).find((item) => item.id === "refresh-conventions")!;
      write(source, "technologies/rust/README.md", "## RUST-001 — Revised rule\n");
      expect(apply(root, source, refresh.id, refresh.approval).status).toBe("failed");
      const current = plan(root, source).find((item) => item.id === "refresh-conventions")!;
      expect(apply(root, source, current.id, current.approval).status).toBe("passed");
      expect(plan(root, source).some((item) => item.id === current.id)).toBe(false);
    });
  });
});
